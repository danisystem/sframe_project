# Videoconferenza E2EE con WebRTC, SFrame e MLS

Questo repository contiene il prototipo sviluppato per la tesi di laurea: un'architettura di videoconferenza di gruppo con cifratura *End-to-End* (E2EE) che integra i nuovi standard IETF **SFrame** (per il piano multimediale) e **MLS** (per il piano di controllo), affiancati da un approccio ibrido basato su WebCrypto API (ECDH).

## 📋 Prerequisiti

Per eseguire correttamente l'infrastruttura sul proprio computer, è necessario avere installato:
- **Docker** (attivo e funzionante).
- **Node.js** e `npm` (per il Gateway applicativo).
- **Rust** e `cargo` (per il Delivery Service).
- Certificati TLS validi per il dominio locale `sframe.local`.

### 1. Modifica del file hosts
Affinché il browser possa risolvere il dominio locale, è fondamentale associare `sframe.local` all'indirizzo IP di loopback. 
Modifica il file `hosts` del tuo sistema operativo (su Windows: `C:\Windows\System32\drivers\etc\hosts`, su Linux/Mac: `/etc/hosts`) aggiungendo questa riga:

```text
127.0.0.1    sframe.local
```

### 2. Generazione Certificati TLS
Il sistema richiede un *Secure Context* (HTTPS/WSS) per abilitare le WebCrypto API e l'intercettazione dei flussi multimediali. Assicurati di aver generato i certificati X.509 validi per il dominio `sframe.local` (ad esempio utilizzando tool come `mkcert` o `CFSSL`) e di averli posizionati nella cartella corretta affinché possano essere letti dal server Node.js.

---

## 🚀 Guida all'avvio

Il sistema è composto da tre servizi paralleli che devono essere avviati in sequenza.

### Step 1: Avvio di Janus SFU (via Docker)
Avvia il server di instradamento video Janus utilizzando l'immagine Docker ufficiale. 
*Nota: sostituisci `<PERCORSO_CONFIG_JANUS>` con il percorso assoluto della cartella contenente i tuoi file di configurazione.*

```bash
docker run --rm -it -p 8088:8088 -p 8188:8188 -p 7088:7088 -p 7889:7889 -p 10000-10200:10000-10200/udp -v <PERCORSO_CONFIG_JANUS>:/usr/local/etc/janus canyan/janus-gateway:latest
```

### Step 2: Avvio del Delivery Service (MLS Server)
Apri un nuovo terminale, naviga nella cartella del server Rust e avvia il servizio:

```bash
cd sframe_project/mls_server
cargo run
```

### Step 3: Avvio del Gateway Applicativo (Node.js)
Apri un terzo terminale, entra nella cartella della WebApp e avvia il server sicuro (che fungerà da proxy WSS e HTTPS):

```bash
cd sframe_project/webapp
npm install
node secure_server.js
```

---

## 💻 Utilizzo dell'Applicazione (Browser)

Una volta avviati tutti e tre i servizi, puoi testare la videochiamata sicura:

1. **Creare la stanza (Primo Utente):**
   - Apri il browser e vai all'indirizzo: `https://sframe.local/appRoom.html`
   - Nel campo **WSS URL**, lascia il valore predefinito: `wss://sframe.local/janus`
   - Inserisci il tuo nome e clicca su **Connect**. Verrà generato e mostrato un ID stanza a 6 cifre.

2. **Unirsi alla stanza (Secondo Utente):**
   - Condividi l'URL con l'ID della stanza generata. Il secondo utente dovrà collegarsi a un link simile a questo: `https://sframe.local/appRoom.html?room=123456` (sostituendo `123456` con l'ID reale).
   - Nel campo **WSS URL**, lascia sempre `wss://sframe.local/janus`.
   - Inserisci il nome, clicca su **Connect** e la sessione avrà inizio!