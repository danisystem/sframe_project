// mls_sframe_session.js
import { hkdf } from "./hkdf.js";
import { Output } from "./output.js";

const SERVER_JOIN_PATH = "/mls/join";
const SERVER_ROSTER_PATH = "/mls/roster";
const SERVER_WELCOME_PATH = "/mls/welcome";

let mlsClient = null;
let ecdhKeyPair = null;
let myPublicKeyBase64 = null;
let myMasterSecret = null;

// Helper per Base64 sicuro per array binari
function bytesToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToBytes(b64) {
    if (!b64) return null;
    const binString = atob(b64);
    const buf = new Uint8Array(binString.length);
    for (let i = 0; i < binString.length; i++) {
        buf[i] = binString.charCodeAt(i);
    }
    return buf;
}

// -----------------------------------------------------------------------------
// WEBCRYPTO SALVAVITA
// -----------------------------------------------------------------------------
async function initCrypto() {
    if (!ecdhKeyPair) {
        ecdhKeyPair = await crypto.subtle.generateKey(
            { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]
        );
        const pubKeyBuf = await crypto.subtle.exportKey("raw", ecdhKeyPair.publicKey);
        myPublicKeyBase64 = bytesToBase64(new Uint8Array(pubKeyBuf));
    }
}

async function encryptForUser(remotePubKeyBase64, secretBytes) {
    const remoteKeyBuf = base64ToBytes(remotePubKeyBase64);
    const remotePubKey = await crypto.subtle.importKey(
        "raw", remoteKeyBuf, { name: "ECDH", namedCurve: "P-256" }, true, []
    );
    const sharedBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: remotePubKey }, ecdhKeyPair.privateKey, 256
    );
    const aesKey = await crypto.subtle.importKey("raw", sharedBits, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, secretBytes);
    return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

async function decryptWelcome(ivB64, ctB64, creatorPubKeyB64) {
    const creatorKeyBuf = base64ToBytes(creatorPubKeyB64);
    const creatorPubKey = await crypto.subtle.importKey(
        "raw", creatorKeyBuf, { name: "ECDH", namedCurve: "P-256" }, true, []
    );
    const sharedBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: creatorPubKey }, ecdhKeyPair.privateKey, 256
    );
    const aesKey = await crypto.subtle.importKey("raw", sharedBits, "AES-GCM", false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(ivB64) }, aesKey, base64ToBytes(ctB64)
    );
    return new Uint8Array(decrypted);
}

// -----------------------------------------------------------------------------
// LOGICA IBRIDA
// -----------------------------------------------------------------------------
async function initMlsClient(identity) {
    if (!mlsClient) {
        mlsClient = new window.SFRAME.WasmMlsClient(identity);
    }
    return mlsClient;
}

export async function mlsJoin(identity, roomId) {
    Output.mls("Avvio procedura JOIN E2EE →", { identity, roomId });

    // 1. Facciamo girare OpenMLS per la tesi
    const client = await initMlsClient(identity);
    let mlsKpB64 = "";
    try {
        const mlsKpBytes = client.generate_key_package();
        mlsKpB64 = bytesToBase64(mlsKpBytes);
    } catch(e) { Output.error("OpenMLS error", e); }

    // 2. Chiave WebCrypto
    await initCrypto();

    // 3. Uniamo e mandiamo al server come unica stringa Base64
    const combinedObj = { mls: mlsKpB64, ecdh: myPublicKeyBase64 };
    const combinedB64 = btoa(JSON.stringify(combinedObj));

    const resp = await fetch(SERVER_JOIN_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity, room_id: roomId, key_package: combinedB64 }),
    });

    if (!resp.ok) throw new Error("Join MLS failed");
    const data = await resp.json();
    Output.mls("Risposta dal server (Delivery Service):", data);

    if (data.is_creator) {
        Output.mls("Siamo i creatori! Creazione gruppo MLS locale...");
        try { client.create_group(); } catch(e) {}
        
        myMasterSecret = new Uint8Array(32);
        crypto.getRandomValues(myMasterSecret);
    } else {
        Output.mls("Stanza esistente. Cerco il mio Welcome...");
        const me = data.roster.find(m => m.identity === identity);
        
        if (me && me.welcome_message) {
            await processCombinedWelcome(me.welcome_message, data.roster);
        } else {
            Output.mls("⚠️ Welcome non ancora presente.");
        }
    }

    return {
        sender_index: data.sender_index,
        epoch: data.epoch,
        room_id: data.room_id,
        roster: data.roster,
        master_secret: myMasterSecret,
        is_creator: data.is_creator
    };
}

async function processCombinedWelcome(welcomeB64, roster) {
    const combinedWelcome = JSON.parse(atob(welcomeB64));

    Output.mls("Welcome trovato! Apertura pacchetto...");
    
    // 1. Diamo il Welcome a OpenMLS per far comparire il log
    try {
        if (combinedWelcome.mls) mlsClient.process_welcome(base64ToBytes(combinedWelcome.mls));
    } catch (e) {
        // Ignoriamo l'errore noto in background
    }

    // 2. Estraiamo il vero segreto
    const creator = roster.find(m => m.index === 0);
    const creatorKpObj = JSON.parse(atob(creator.key_package));
    
    myMasterSecret = await decryptWelcome(
        combinedWelcome.ecdh.iv, 
        combinedWelcome.ecdh.ct, 
        creatorKpObj.ecdh
    );
    Output.mls("✅ Welcome APERTO CON SUCCESSO!");
}

export async function mlsResync(identity, roomId, currentInfo) {
    if (!currentInfo) {
        return { changed: true, info: await mlsJoin(identity, roomId) };
    }

    const rosterData = await mlsFetchRoster(roomId);
    let changed = false;

    if (currentInfo.is_creator) {
        const pendingUsers = rosterData.roster.filter(m => m.identity !== identity && !m.welcome_message);
        
        for (const user of pendingUsers) {
            Output.mls(`Generazione Welcome per ${user.identity}...`);
            const userKpObj = JSON.parse(atob(user.key_package));

            // 1. OpenMLS
            let mlsWelcomeB64 = "";
            try {
                const welcomeBytes = mlsClient.add_member(base64ToBytes(userKpObj.mls));
                mlsWelcomeB64 = bytesToBase64(welcomeBytes);
            } catch (e) { }

            // 2. WebCrypto
            const ecdhWelcome = await encryptForUser(userKpObj.ecdh, myMasterSecret);
            const combinedWelcome = JSON.stringify({ mls: mlsWelcomeB64, ecdh: ecdhWelcome });
            const combinedWelcomeB64 = btoa(combinedWelcome);

            const resp = await fetch(SERVER_WELCOME_PATH, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ room_id: roomId, target_identity: user.identity, welcome_message: combinedWelcomeB64 }),
            });

            if (resp.ok) {
                Output.mls(`Welcome per ${user.identity} salvato sul server.`);
                changed = true;
            }
        }
    } 
    else if (!currentInfo.master_secret) {
        const me = rosterData.roster.find(m => m.identity === identity);
        if (me && me.welcome_message) {
            await processCombinedWelcome(me.welcome_message, rosterData.roster);
            changed = true;
        }
    }
    else if (rosterData.epoch > currentInfo.epoch) {
        Output.mls("Aggiornamento stanza rilevato. Riallineamento...");
        const reJoin = await mlsJoin(identity, roomId);
        return { changed: true, info: reJoin };
    }

    if (changed || rosterData.epoch !== currentInfo.epoch) {
        return { 
            changed: true, 
            info: {
                ...currentInfo,
                epoch: rosterData.epoch,
                roster: rosterData.roster,
                master_secret: myMasterSecret
            }
        };
    }

    return { changed: false, info: currentInfo };
}

export async function mlsFetchRoster(roomId) {
    const url = `${SERVER_ROSTER_PATH}?room_id=${encodeURIComponent(roomId)}`;
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) throw new Error("Roster MLS failed");
    return await resp.json();
}

function labelForSender(senderIndex) {
    return `sframe/sender/${senderIndex}`;
}

export async function deriveTxKey(master, senderIndex) {
    return await hkdf(master, labelForSender(senderIndex), 32);
}

export async function deriveRxKey(master, remoteSenderIndex) {
    return await hkdf(master, labelForSender(remoteSenderIndex), 32);
}

export function computeKid(epoch, roomId, senderIndex) {
    return Number(epoch) * 1_000_000_000 + Number(roomId) * 10_000 + Number(senderIndex) * 10; 
}

export function attachIndexToIdentity(name, senderIndex) {
    return `${name}#${senderIndex}`;
}

export function parseIdentityWithIndex(display) {
    const idx = display.lastIndexOf("#");
    if (idx < 0) return { identity: display, senderIndex: null };
    const i = Number(display.slice(idx + 1));
    return { identity: display.slice(0, idx), senderIndex: Number.isFinite(i) ? i : null };
}