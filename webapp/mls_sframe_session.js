// mls_sframe_session.js
// MLS → distribuzione segreti per SFrame (webapp, multi-room)

import { hkdf } from "./hkdf.js";
import { Output } from "./output.js";

// Usiamo path relativi: ci pensa secure-server.js a fare da proxy verso 127.0.0.1:3000
const SERVER_JOIN_PATH = "/mls/join";
const SERVER_ROSTER_PATH = "/mls/roster";

function base64ToBytes(b64) {
    if (typeof b64 !== "string") {
        throw new Error("base64ToBytes: input non è una stringa");
    }
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
}

// ---------------- MLS JOIN ----------------
//
// Ogni join ora è per (room_id, identity):
// - room_id = Room Janus (es. 123456)
// - identity = "dani", "mac", ecc.
//
// NOTA concettuale:
// Il campo master_secret è da intendersi come segreto *dell'epoch corrente*
// per quella stanza. Quando in futuro il server MLS ruoterà l'epoch ad ogni
// join/leave, questo valore cambierà e i client dovranno riallinearsi.
export async function mlsJoin(identity, roomId) {
    Output.mls("JOIN →", { identity, roomId });

    const resp = await fetch(SERVER_JOIN_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // ⚠️ campo che il server Rust si aspetta: room_id
        body: JSON.stringify({ identity, room_id: roomId }),
    });

    if (!resp.ok) {
        throw new Error("Join MLS failed: HTTP " + resp.status);
    }

    const data = await resp.json();
    Output.mls("JOIN success:", data);

    const masterBytes = base64ToBytes(data.master_secret);
    return {
        sender_index: data.sender_index,
        epoch: data.epoch,
        group_id: data.group_id,
        room_id: data.room_id,
        roster: data.roster,
        master_secret: masterBytes,
    };
}

// ---------------- MLS RESYNC (epoch change) ----------------
//
// Questa funzione serve per il "prossimo step":
// - un peer è già nel gruppo (ha currentInfo)
// - qualcosa nel gruppo potrebbe essere cambiato (nuovo peer / leave)
// - vogliamo sapere se l'epoch MLS è avanzata e, in tal caso,
//   aggiornare master_secret + epoch + roster.
//
// Implementazione NON distruttiva:
// - internamente richiamiamo semplicemente /mls/join con la stessa
//   identity e roomId
// - il server MLS, una volta aggiornato, dovrà restituire lo stato
//   dell'epoch corrente (eventualmente ruotato)
// - se l'epoch è cambiata rispetto a currentInfo.epoch, ritorniamo
//   changed: true e il nuovo info
//
// Uso previsto (in appRoom.js, in futuro):
// const { changed, info } = await mlsResync(identity, roomId, mlsInfo);
// if (changed) {
//   mlsInfo = info;
//   // rigenera txPeer/rxPeer + KID usando il nuovo master_secret/epoch
// }
export async function mlsResync(identity, roomId, currentInfo) {
    // Se non abbiamo ancora un currentInfo, comportati come un join "normale"
    if (!currentInfo) {
        const info = await mlsJoin(identity, roomId);
        return { changed: true, info };
    }

    const newInfo = await mlsJoin(identity, roomId);

    if (newInfo.epoch !== currentInfo.epoch) {
        Output.mls("MLS RESYNC: epoch changed", { oldEpoch: currentInfo.epoch, newEpoch: newInfo.epoch });
        return { changed: true, info: newInfo };
    }

    // Epoch invariata → mantieni le chiavi attuali
    Output.mls("MLS RESYNC: epoch unchanged", { epoch: currentInfo.epoch });
    return { changed: false, info: currentInfo };
}

// ---------------- MLS ROSTER (refresh) ----------------
//
// GET /mls/roster?room_id=123456
//
// Resta invariato: lo useremo come "vista" dello stato membri, mentre
// il segreto effettivo per l'epoch corrente continuerà a passare da
// /mls/join (o mlsResync).
export async function mlsFetchRoster(roomId) {
    const url = `${SERVER_ROSTER_PATH}?room_id=${encodeURIComponent(roomId)}`;
    const resp = await fetch(url, { method: "GET" });

    if (!resp.ok) {
        throw new Error("Roster MLS failed: HTTP " + resp.status);
    }

    const data = await resp.json();
    Output.mls("ROSTER update:", data);

    return data; // { epoch, group_id, room_id, roster }
}

// ---------------- Derivazione chiavi ----------------
//
// Concettualmente:
// - master_secret = segreto dell'epoch corrente (epoch_secret)
// - per ogni sender_index deriviamo una chiave "di sender"
// - da quella, (se servisse) potremmo derivare chiave audio/video
// - per ora manteniamo l'API esistente per non rompere nulla.
function labelForSender(senderIndex) {
    return `sframe/sender/${senderIndex}`;
}

// Chiave TX per questo peer (sender_index locale)
export async function deriveTxKey(master, senderIndex) {
    const key = await hkdf(master, labelForSender(senderIndex), 32);
    Output.mls("Derived TX Key", { senderIndex });
    return key;
}

// Chiave RX per un certo sender_index remoto
export async function deriveRxKey(master, remoteSenderIndex) {
    const key = await hkdf(master, labelForSender(remoteSenderIndex), 32);
    Output.mls("Derived RX Key", { remoteSenderIndex });
    return key;
}

// ---------------- KID univoci (epoch + room + sender) ----------------
//
// computeKid viene usato sia lato TX che RX e già incorpora l'epoch.
// Quando l'epoch MLS viene incrementata e i peer aggiornano mlsInfo,
// i nuovi KID derivati da questa funzione saranno automaticamente
// diversi dai precedenti, garantendo separazione tra epoch.
export function computeKid(epoch, roomId, senderIndex) {
    const e = Number(epoch) >>> 0;
    const r = Number(roomId) >>> 0;
    const s = Number(senderIndex) >>> 0;

    // layout: [ epoch | roomId | senderIndex | mediaBit ]
    // epoch * 1e9 + room * 1e4 + sender * 10
    const base = e * 1_000_000_000 + r * 10_000 + s * 10;
    return base; // audio; video = base + 1
}

// ---------------- Identity helper ----------------
export function attachIndexToIdentity(name, senderIndex) {
    return `${name}#${senderIndex}`;
}

export function parseIdentityWithIndex(display) {
    const idx = display.lastIndexOf("#");
    if (idx < 0) {
        return { identity: display, senderIndex: null };
    }
    const identity = display.slice(0, idx);
    const indexStr = display.slice(idx + 1);
    const i = Number(indexStr);
    if (!Number.isFinite(i)) {
        return { identity: display, senderIndex: null };
    }
    return { identity, senderIndex: i };
}
// -----------------------------------------------------------------------------
// TODO (scelta progettuale / possibile miglioramento)
//
// Attualmente il sistema deriva:
//   - un solo key_material per ciascun sender_index (tramite HKDF su master_secret)
//   - lo stesso key_material viene riutilizzato sia per audio che per video
//
// La separazione tra audio e video NON avviene a livello HKDF,
// ma a livello SFrame, tramite KID diversi:
//   - audio  → kid = base
//   - video  → kid = base + 1
//
// Poiché EncryptionKey::derive_from(...) incorpora il KID nella derivazione,
// audio e video finiscono comunque con chiavi finali diverse, pur partendo
// dallo stesso key_material.
//
// In futuro, se si volesse una separazione più forte o più esplicita,
// si potrebbe:
//   - derivare key_material distinti per audio e video usando label HKDF diverse
//   - oppure esporre nel WASM un'API TX-only / RX-only che accetti segreti separati
//
// La scelta attuale è consapevole ed è sufficiente per il modello SFrame usato,
// ma questo punto è lasciato come possibile estensione futura.
// -----------------------------------------------------------------------------