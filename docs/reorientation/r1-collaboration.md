# Café collaboration in Scribyra: investigation report

Date: 2026-11-05. Investigation only: nothing in the product changed. Saved after the [decision record](../reorientation.md) was written; see it and the [roadmap](../roadmap.md) for what was decided from this.

Labels: **[M]** measured here, **[V]** verified from a cited source, **[I]** my inference. Unless a row says otherwise, measurements are single samples.

## Verdict

**Only partly. It works on some café networks and cannot work on others, and nothing inside a browser can fix the second group.**

- **Synced, with no install and no server: yes, where the Wi-Fi lets laptops reach each other.** Real Yjs projects synced over WebRTC data channels between Chromium 156 and Firefox 157, in both directions, using a manual exchange only [M].
- **Blocked Wi-Fi: no.** With client isolation on, every variation tested failed: mDNS, and a camera grant exposing raw addresses [M]. A typed address was not run under isolation, but it relies on the same blocked path [I]. Getting past it takes a server, a different network or a cable. I found no measured figure for how many cafés isolate clients, so **I cannot give you a failure rate**. Only a field test can.
- **Encrypted: yes on the wire, but not "end-to-end encrypted collaboration" as a public claim.** DTLS 1.3 protects the link, and a tampered fingerprint fails the connection [M]. It does not provide group membership, removing a person, encryption at rest or attribution. The roadmap also requires independent review before strong claims.
- **Safari is unknown.** Playwright's Linux WebKit could not connect using mDNS at all, even to itself. That may be specific to the Linux build, so a real Mac test is required [M/I].
- **Recommendation:** run the two-laptop test first (under a day to prepare; the test page already exists). Build this only as an opportunistic direct transport beneath the same encrypted replication layer as milestones 10/11. It complements those milestones and does not replace them. If cafés with internet matter most, the opaque relay is the reliable path, because it does not care about isolation.

## What works and what fails

Each "laptop" here is a separate Linux network namespace on a virtual bridge, so the two have separate network stacks. This is closer than same-host testing, but **it proves nothing about real Wi-Fi radios, access points, OS firewalls or laptop sleep**. Browsers ran headless, and Playwright disables Chromium field trials, so real Chrome may differ.

| Network condition | Chromium | Firefox | Result and fix |
| --- | --- | --- | --- |
| Open LAN, multicast allowed | Connects, 14 ms after applying the answer | Connects, 36 ms | Ch↔Ff also connects, 28–31 ms. No permission needed [M] |
| Multicast blocked, unicast allowed | Never connects; stays `new` indefinitely | Fails at about 5 s | Fixable below [M] |
| Same, camera granted on at least one side | Connects, with one or both sides granted | Still mDNS with a fake camera, still fails | Ch(granted)↔Ff connects. Firefox result may be a harness artefact [M] |
| Same, A types B's Wi-Fi IP | Connects, 25 ms | Connects, 36 ms | Ch↔Ff also connects. The port comes from B's reply. WebKit↔WebKit connected this way on an open LAN [M] |
| Client isolation (bridge port isolation) | mDNS stays `new`; raw IPs fail at about 15 s | Fails at about 5 s | **No browser-side fix** [M] |
| LAN with no default route | No candidates at all | No candidates; gathering never finishes | Chromium with camera grant connects [M] |
| Default route via a VPN-like interface | mDNS candidate only, no connection | Fails | Chromium with camera grant connects [M]. A full-tunnel VPN will probably break this [I] |
| No usable interface | No candidates, gathering hung | Not completed | No connection [M] |

Two findings affect the product directly:

- **Chromium gives no failure signal when mDNS names cannot be resolved.** It stays in `new` forever, so the UI needs its own timer and diagnosis [M].
- **The app must already be cached.** A browser cannot serve the app to a peer. Someone who has never opened Scribyra cannot join with no internet [I]. Offline reload and compile are already supported, and the sample compiled in all three engines with no network at all [M].

## Transport: what a browser can actually do

| Option | Status | Usable? |
| --- | --- | --- |
| **WebRTC data channel** | Present in all three engines [M] | **Yes, the only real candidate** |
| Direct Sockets | Restricted to Isolated Web Apps ([Chrome docs](https://developer.chrome.com/docs/iwa/direct-sockets)) [V]. `TCPSocket`, `TCPServerSocket` and `UDPSocket` are undefined on a normal page in all three engines [M]. IWAs were documented for managed ChromeOS and select partners ([chromeos.dev](https://chromeos.dev/en/web/isolated-web-apps), page around ChromeOS 128, so may be stale) [V] | No. Installing one conflicts with "open it and it works", and it is Chromium-only |
| WebTransport | Client-to-server only ([secondary source](https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/)) [V]. `RTCQuicTransport` undefined in all three [M] | No. A page cannot listen |
| Web Bluetooth | Connects to peripherals; not in Firefox or Safari ([MDN](https://developer.mozilla.org/Web/API/Web_Bluetooth_API)) [V]. I found no advertising API, so two laptops have nothing to connect to [I]. Absent in this harness on all three [M] | No |
| Web NFC | `NDEFReader` absent in all three on Linux [M] | No for laptops |
| Mic/speaker data for the invite | Untested. Low bitrate and needs the mic permission [I] | A curiosity, not a plan |
| Exported update file (USB, AirDrop) | Should work on any network; asynchronous [I] | Useful fallback, not built |

**Chrome policy risk (Local Network Access).** Chrome plans to put WebRTC to local addresses behind a permission prompt. [Chromestatus](https://chromestatus.com/feature/5065884686876672) shows "Proposed", last updated September 2025, with no milestone [V]. Other sources conflict: [Jamf](https://support.jamf.com/en/articles/12894739-chrome-local-network-access-prompts-with-jamf-trust-ztna) says Chrome 146 enforces it, while a [third-party guide](https://www.superchargebrowser.com/library/chrome-156-local-network-access) says WebRTC is out of scope. Measured on Chromium 156 with the page treated as a public address [M]:

| Setting | Connected? |
| --- | --- |
| Default | Yes |
| `LocalNetworkAccessChecksWebRTC` feature on | **No, stays `new`** |
| Feature on, permission granted | Yes |
| Feature on, `LoopbackOnly=true` | Yes |
| Feature on, page on a local or loopback address | Yes |

So a hosted public origin may later need a browser permission prompt, or may need it now under field trials. That is a prompt and not an install, but in this test a blocked connection gave no failure signal. The field test covers it.

## Signaling and discovery with no server

A browser cannot discover peers, so each pair must exchange connection details.

| Form | Size [M] | QR (byte mode) | Assessment |
| --- | --- | --- | --- |
| Raw SDP | 586–759 B | Not practical | |
| Deflated, base64url | 599–666 chars | Version 17–20 | Paste works; QR is too dense for a laptop webcam [I] |
| **Compact binary, SDP rebuilt from a template** | **71–95 B** (95–127 base64 chars) | **Version 4–6** | **Connected and synced in Ch↔Ch, Ff↔Ff and both cross directions** [M] |
| Same, with ICE credentials derived ([QWBP](https://magarcia.github.io/qwbp/spec.html)) | About 42–54 B, calculated only | Version 3–4 | Not tested; relies on setting local ICE credentials |
| Short typed code | Impossible | | See below |

- **A short code cannot work without a rendezvous server.** The 32-byte certificate fingerprint and an address must reach the peer, and a browser cannot choose its certificate to derive it from a code. Roughly 70–90 base32 characters is the floor, in each direction [I, from measured sizes].
- **QR needs a bundled decoder.** `BarcodeDetector` is undefined in all three engines here [M], and [MDN says it is not Baseline](https://developer.mozilla.org/en-US/docs/Web/API/Barcode_Detection_API) [V]. QR codes also ask two people to face their laptops at each other, and each must scan the other. **Real webcam scanning is untested.**
- **The camera prompt has a useful side effect in Chromium:** the grant exposes raw addresses, which fixes the multicast-blocked case [M]. The stream must be live before gathering.
- **Paste needs a channel.** A chat app works, but needs internet and becomes the trust root for that exchange [I].

Only the first exchange per joiner is manual. Later mesh links can be signaled over existing data channels: 5 people needed **4 manual exchanges for 10 links**, formed in 3.0 s with no human delay [M].

| Signaling option | Needs | What it leaks | Comment |
| --- | --- | --- | --- |
| Manual (QR or paste) | Nothing | Candidates visible to whoever sees the blob, and the private IP with a camera grant | Works offline |
| Self-hosted opaque relay in `scribyra-sync` | Always-on service, internet | Operator sees IPs, timing, room identifier, who pairs with whom | `crates/sync` is a loopback demo with fixed origins and would need new routes. A PAKE is required, or the operator can swap fingerprints |
| Public rendezvous | Third party, internet | The same, to someone you do not control | Not recommended. [y-webrtc's defaults](https://github.com/yjs/y-webrtc/) rely on such servers |

**If a relay is available, it should probably carry the data too** [I]. An isolated network with internet then just works, while a signaling-only relay would still fail there.

## Café networks: the likely real blocker

**Verified**

- Client isolation is a vendor feature that was never standardized, and implementations vary ([AirSnitch, NDSS 2026](https://www.ndss-symposium.org/wp-content/uploads/2026-f1282-paper.pdf)) [V].
- That paper tested 5 home routers, 2 router distributions, an enterprise testbed and 2 university networks. **It is a security study, not a prevalence survey.**
- [LocalSend's project page](https://github.com/localsend/localsend) lists AP isolation as a cause of failure [V].
- Apple describes Personal Hotspot as designed for internet access, with no promise of device-to-device traffic ([Apple forum](https://developer.apple.com/forums/thread/85509)). Forum reports describe clients being isolated, possibly only over IPv4 [V, weak].

**Not found**

- Any measured percentage for cafés. Claims that small venues leave isolation off and chains turn it on come from [blogs](https://dev.to/lafine_systemsdesign/youre-probably-overestimating-public-wi-fi-client-isolation-2ao0) and vendor guides, so treat them as a hypothesis.
- Any documented Android hotspot behaviour.

**Inferred**

- Chains, managed guest networks and captive-portal networks are the likeliest to block.
- **Isolation at layer 2 does not always cover layer 3.** AirSnitch's "gateway bouncing" shows clients often can route via the gateway [V]. So public STUN might connect some isolated clients if the router hairpins. I did not test this. It needs internet and tells Google your IP.
- TURN would work but sends the traffic out and back through a server, so it is no longer local. It needs a server, internet and credentials a static app cannot keep secret. If you run a server, the milestone 10 relay gives you more.
- Captive portals may block peer traffic until login.
- A phone hotspot is a fallback worth testing, not one to promise. A hotspot made by one of the laptops avoids client-to-client isolation for that pair, but OS support varies.
- Windows or macOS firewalls may interfere.

## Encryption, identity and threat model

**What was measured**

- Data channels negotiated DTLS 1.3 (`0xFEFC`) with `TLS_AES_128_GCM_SHA256` in the Chromium and Firefox pairs where I read the stats [M].
- Changing one fingerprint byte in either direction makes the connection fail [M].
- **A man in the middle of signaling succeeds at the DTLS level on both sides.** It was only visible because comparing a code derived from both fingerprints gave different values (e.g. 926066 vs 052281). Honest pairs matched [M]. MDN says the same: fingerprints do not [validate user identity](https://developer.mozilla.org/en-US/docs/Web/API/RTCCertificate/getFingerprints) [V].
- **My 6-digit comparison code is only a demonstration.** Without a commit-reveal step an attacker can generate certificates until the code matches [I].
- An AES-GCM layer over updates and blobs adds 28 B per message, with no visible throughput cost (41.8 s vs 42.4 s for 60 MiB under emulated Wi-Fi), and a wrong key is rejected [M]. X25519, Ed25519 and persistent certificates (365 days, stored in IndexedDB) work in all three engines [M].

**Verifying each other**

| Situation | Method | Note |
| --- | --- | --- |
| Same table, QR | The optical channel authenticates the fingerprints; add a committed comparison code | No PAKE needed |
| Paste via chat | Trust equals the chat, plus a comparison code | |
| Through a relay | PAKE from a short code, bound to both fingerprints | [CPace draft 21](https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/) is with the RFC Editor, not yet published [V]. It would likely be Rust/WASM, reviewed [I] |
| Rejoining | Pinned certificate fingerprint | Certificates expire within a year ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/generateCertificate)) [V] |
| Mesh links relayed through a member | **Must be signed by identity keys** | Otherwise the relaying member can intercept them. My prototype does not do this [I] |

**Is application-layer encryption still needed?** Not to hide content from a passive café observer on a direct, verified link. It is needed for anything relayed or stored, for membership changes, and to share one design with milestone 11. So yes, for anything beyond a two-person experiment.

| Threat | Direct session with verified fingerprints |
| --- | --- |
| Passive listener on café Wi-Fi | Cannot read content. Sees IPs, ports, timing, volume and mDNS queries [I] |
| Active attacker on Wi-Fi | Can block the connection. Cannot read or inject without swapping fingerprints during signaling [I]. AirSnitch shows isolation is no defence, so do not rely on it [V] |
| Attacker in the invite channel | Succeeds unless verified [M] |
| Malicious admitted member | Can write or delete anything and forge their Yjs client ID. Yjs has no access control. Needs signed updates and validation [I] |
| Removed member | Keeps everything already received, which cannot be undone. Future exclusion needs key rotation and a signed roster. Concurrent removal without a server is still research territory ([Keyhive](https://www.inkandswitch.com/project/keyhive/), [DCGKA notes](https://www.inkandswitch.com/keyhive/notebook/05/)) [V] |
| Stolen or compromised laptop | Project is unencrypted in browser storage, so nothing here helps [I] |
| Forward secrecy | Each DTLS session should use fresh keys, so a long-term identity key should not expose past traffic [I]. A long-lived group key would lose this unless rotated |

**Data disclosed when sharing** [M]: project updates include the **trash, with deleted files' full text**. Deleted text can also be on the wire if the sender has a live undo manager (without one it is removed, and the receiver's copy discards it). The UI must warn about this or send a cleaned copy. Provider credentials appear to live outside the document, based on a light check of the code [I].

**Could honestly be claimed after a good field test:** "Connects directly between browsers, with no Scribyra server. The connection is encrypted by WebRTC. Check the code to confirm who you are connected to. Works only on networks that allow devices to reach each other."

**Should not be claimed yet:** "end-to-end encrypted collaboration", "secure against your network", "works in any café", or removal or revocation guarantees. These wait for milestone 11's gate and independent review. Also not "private from peers": direct connections expose addresses to them.

## Sync behaviour

Measured with the repository's project model, blob verification and Yjs 13.6.33 on `fixtures/thesis` (101 files, 127,779 B of text) [M].

| Test | Result |
| --- | --- |
| Thesis initial sync, virtual LAN | 147,798 B on the wire; 35–53 ms; converged |
| Thesis, emulated Wi-Fi (20 Mbit, 5 ms, 0.5% loss, each side) | 117–140 ms |
| Thesis plus synthetic 60 MiB random asset, LAN | 3.7–6.6 s, with one 12.0 s outlier; hash verification about 1 s |
| Same, emulated Wi-Fi | 42 s, about 12 Mbit/s |
| Edit reaches peer, 2–5 people | At most 22 ms on the virtual LAN (includes harness polling) |
| Concurrent edits, 5 people, Chromium and Firefox mixed | Converged |
| Rejoin after both sides edited offline | 62–84 B instead of 147,798 B; converged |

The prototype uses 16 KiB chunks with buffer limits of 256 KiB and 1 MiB. `maxMessageSize` read 262,144 whenever Chromium was involved and about 1 GiB for Firefox-only pairs [M], so all large messages must be chunked. Emulated figures are illustrative, not a Wi-Fi prediction.

- **Topology:** a full mesh suits 2–5 people, and the group survived the original host leaving [M]. Binary assets should be pulled from one peer at a time, and shared airtime is unmeasured [I].
- **Drops and sleep** [M]:

| Event | Chromium | Firefox |
| --- | --- | --- |
| Wi-Fi link down 5 s | Recovers | Recovers |
| 20 s | `failed`; not recovered within about 12 s of the link returning; new exchange | Recovered |
| 60 s | `failed`; new exchange | `failed` at about 30 s, channel closes; new exchange |
| Browser frozen 60 s (a rough stand-in for sleep) | Recovers, even after `failed` | Fails; new exchange |

  Real sleep also drops Wi-Fi association and may change the address, so expect a new exchange in practice [I]. With no server, rejoining requires another peer who is still connected, or another manual exchange.
- **Long offline with no always-on peer:** edits merge whenever two peers overlap, but nothing holds them in between. Status must never suggest backup [I]. Use the roadmap's separation of "saved on this device" from "backed up remotely".
- **A real failure my prototype hit:** one update that was never sent left the receiver holding every later update from that peer as pending, with no error on either side [M]. The protocol needs state-vector exchange in both directions on connect and periodically afterwards.
- **Same-browser tabs:** one tab should hold the connection, using Web Locks (available in all three [M]). Others can follow through the existing committed-head path, since peer updates would be saved like any other [I]. If that tab closes the session drops and must be re-established [I].
- **Integration points in the code** [I, from reading]:
  - `web/main.js:139` treats anything not `LOCAL_DURABLE` as a local edit and saves it. This is mostly right for peers, but its status needs care.
  - Auto-compile would fire on peer edits, on every laptop.
  - The incoming path should reuse `web/local-tabs.js`: preview, schema check, blob verification, binary recovery and the IME guard.
  - `web/sync.js` is a plaintext loopback demo and is not a usable base.
- **Undo:** a peer origin stays out of the undo stack, so undo removed only that person's own edit in both engines tested [M]. The app's tracked origins are `null` and `CompanionOrigin` (`web/main.js:237`), so the transport must use its own non-null origin.
- **Origins and deployments:** WebRTC does not require a shared origin, so different deployments should be able to connect [I, not measured]. They need a version handshake, and `SCHEMA_VERSION` mismatches are already rejected in the tab path. Storage is per origin, so joining creates a local copy.
- **PDFs** [M]: the sample compiled offline in all three engines to 72,727 B. Output is **identical except for `/CreationDate`, `/ModDate` and `/ID`**, across engines and across runs a minute apart. Only the sample was tested, and only on Linux.
  - Lock metadata syncs in the project, but package archives do not (`docs/tex-packages.md`). So offline, one laptop may compile while another cannot [I]. The existing package bundle export is the workaround.
  - Different builds are rejected by the lock check, which would surprise two people on different deployments [I].
  - `\today` and similar will differ [I].

## AI participants

An agent in a person's tab edits through that tab, so peers see ordinary remote edits under that tab's Yjs client ID [I]. Without added metadata, nobody can tell human from agent, and the attribution would not be cryptographic either way. Mark agent edits with a separate origin and an awareness label, and show peers that an agent is connected. An AI, especially a remote one, reads decrypted content, including other people's text. The roadmap already treats integrations as separate trust decisions, so other participants should be told. Wait for R4 before designing this further.

## Recommended design

1. **Shared replication layer:** two-way state-vector sync with periodic checks, chunked framing, hash-verified blob requests, the `local-tabs.js` validation pipeline and clear status. Transport-independent.
2. **Direct transport:** WebRTC with no ICE servers by default.
3. **Invite:** compact binary (under about 120 B with session and version fields) offered as copy/paste first and QR second. Paste keeps it accessible without a camera.
4. **Connection ladder, with its own 8–10 s timer:**
   1. Try mDNS, with no prompts.
   2. Offer "type your partner's IP address", or the camera permission.
   3. Say plainly: "This network seems to block devices from reaching each other." Offer a hotspot, a configured relay or an update file.
5. **Identity:** Ed25519 key per browser profile, bound to both DTLS fingerprints, with a committed comparison code and pinned contacts. Relayed mesh signaling must be signed.
6. **Group:** full mesh up to 5 people, joined through any member.
7. **Before sharing:** show what will be shared, including trash.
8. **Later, with milestone 11:** per-project keys, encrypted updates and blobs, rotation on removal, encryption at rest. All transports use the same envelope.

## Relationship to the milestones

| Milestone | Effect |
| --- | --- |
| **4c** Paired local devices | **Replace its browser route.** The companion LAN hub is frozen, and R3 must replan 4c anyway. A browser peer session fits the "no install" decision. The roadmap's line that a browser cannot become an always-running LAN server stays true: this session exists only while tabs are open |
| **10** Remote sync | **Complements; not replaced.** Only a service gives durability, catch-up with no overlap, and reliability on isolated networks. Invites, membership, awareness, catch-up and acknowledgements should be shared |
| **11** Encryption | **Not satisfied; bring part of the design forward.** The direct session meets none of the gate items, such as fresh-device recovery, revocation and compaction with stale clients. Link encryption alone does not satisfy it, in the spirit of the roadmap's "TLS alone" rule. Design the key model and envelope before building either transport so there is only one crypto design |
| **5, 6** Comments, reviews | No dependency. Permission roles matter more once peers exist |
| **7** History, backup | Peers are not a backup. Keep that distinction visible |
| **Roadmap rule** | "Add WebRTC peer sessions only after measuring a reason to prefer them over the existing relay design." The reason found is **no server and no internet**, and only on permissive networks. Reliability still favours the relay |
| **Private repo and Pages** | No conflict, but every participant currently needs access to the private deployment, and first load needs internet. Practical use by strangers waits for public launch. A page on a local address avoided the Chrome gating in the emulated test [M] |

**Suggested order, for you to decide:** run the field test now, since it blocks nothing. Keep R4 → R5 as they are. Then decide under R3. If the field test is good and you want this early, do the replication layer first, then a direct-transport experiment behind a flag. It should not skip the key design.

## Effort

Rough estimates [I], assuming one engineer or agent and the acceptance rigour this repository uses.

| Work | Size | Estimate |
| --- | --- | --- |
| Field test (page done), the owner's time at venues | S | Under 1 day to prepare, plus a few hours per venue |
| Shared replication layer, integration, tests | M | 1–2 weeks |
| Direct transport, invites, connection ladder, UI | M | 1–2 weeks |
| QR: decoder, camera flow, real webcam testing | S–M | 3–5 days |
| Mesh, signed relay signaling, rejoin, tab handling | M | 1–2 weeks |
| Browser matrix including real Safari and Windows | M | About 1 week, needs a Mac |
| **Experimental direct sessions (subtotal)** | **L** | **About 5–8 weeks** |
| Identity, key model, envelope, rotation, at-rest (milestone 11 core) | L | 4–8 weeks, overlaps M11 |
| Independent security review | Not sized | Not yet scheduled |
| Opaque signaling in `scribyra-sync` | S–M | Under a week, if the service exists |
| Agent attribution | S | After R4 |

## Two-laptop test

Same-host and namespace tests cannot answer this. The page is [`field-test.html`](field-test.html). It is one self-contained file that sends only random bytes, stores nothing and contacts no server unless you tick STUN. I drove it between two namespaces, Chromium to Firefox, with multicast blocked: it connected via the typed address and moved 20 MiB [M]. It has **not** been opened from `file://`,.

**Before leaving home**

1. Decide how to host it. Serving it from an HTTPS URL on a public IP also tests Chrome's permission gating, and needs your approval since I deployed nothing. A private Pages test path would do. Opening the file directly is the fallback.
2. Use regular Chrome on both laptops, and ideally Safari on a Mac and Firefox for later rounds.
3. Note the OS, browser version and any VPN. Turn VPNs off for the first run.
4. Load the page on both laptops while online, and keep the tabs open.

**At home first, as a control**

5. Join both laptops to the same home Wi-Fi.
6. On A, click **Create invite** and send the text to B by any means.
7. On B, paste it and click **Create reply**, then send that back to A.
8. On A, paste the reply and click **Connect**. Wait 15 seconds.
9. Click **Send 20 MiB test**, then **Copy result** on both, and save the text.

**At each café**

10. Note the venue, whether it is a chain, whether there was a captive portal, and the time.
11. Log in to the portal on both laptops, and record whether you tried before login.
12. Repeat steps 6–9, reloading the page first.
13. If it does not connect, go through these in order, reloading and starting a fresh exchange each time except for the typed address, and save the result each time:
    - Look up B's Wi-Fi IP in OS settings, type it on A and click **Try typed address**. This uses the current exchange.
    - Click **Grant camera first** on both, then repeat the exchange.
    - Tick STUN on both and repeat the exchange. This sends your IPs to Google, so skip it if you prefer.
14. If it connected, close A's lid for 2 minutes, reopen, and note whether the status recovers.
15. Try a phone hotspot with both laptops joined, for each phone type you have.

**Also run once**

16. Mac with Safari to Safari, Safari to Chrome, and Windows to Mac.
17. Chrome from the hosted page, noting any local network prompt. Try denying it.
18. A hotspot with its internet off, for the no-internet case.

**What to send back:** the saved results. Each one records candidates, connection time, path type, DTLS version, round-trip time and throughput.

**How to read it.** A proposal, yours to change:

- Connecting without prompts at most venues supports building it.
- Mostly isolated venues mean prioritizing the relay, and direct mode stays niche.
- Ten venues give a rough picture, not a rate. Choose them to reflect where you would actually use this.

## Limits of this evidence

- Virtual bridge in an LXC, Linux only, headless, no radios. Isolation and multicast blocking are emulated, and real access points can behave differently.
- No real Safari. In these tests WebKit connected only with a raw or typed address [M]. Whether real Safari resolves mDNS is unmeasured.
- Firefox's camera exception was tested with a fake stream and no real permission, so its failure is inconclusive.
- Single samples; timings are from an emulated network. The harness used polling, which affects small latencies. The 12.0 s outlier is unexplained.
- Chromium ran with field trials off, so the real Chrome rollout state is unknown. Sources on Local Network Access for WebRTC disagree. I did not read the Chromium issue itself (crbug.com/421223919).
- The Firefox and Ch↔Ff no-default-route results came from an earlier run whose JSON a later rerun overwrote. They survive only in my console output, so rerun `t_noroute.mjs` with those cases to reproduce them.
- Compact signaling used a fixed SDP template and only UDP host candidates. It has not been tried against a real multi-interface laptop.
- Encryption here is a demonstration (random IVs, a shared passphrase), not a design. Nothing has had security review.
- STUN, hairpin NAT and TURN were not tested. Some sources are secondary, weak or old, as marked. RFC-level detail on WebRTC's security architecture was not re-read for this report.

## Retained files

- [`field-test.html`](field-test.html): the two-laptop test page.
- [`data/collaboration/`](data/collaboration/): raw results and the scripts that produced them. Local paths in them are replaced with `<repo>` and `<scratch>`, so they need those restored to run. The harness bundle, its WASM copy, the thesis JSON, the three sample PDFs and copies of source pages are not kept: the first three rebuild from the repository, and `pdf.json` records the PDF comparison.
- `nix` fetched `mesa` and `poppler-utils` into the store for WebKit's software rendering and for reading a PDF. Nothing was installed into a profile or system-wide.

Sources accessed 2026-11-05.

## Addendum — human reply delay, 2026-11-05

**The earlier “manual exchange” results were automated, zero-delay exchanges. They did not measure the time a person takes to carry the reply back.** This addendum supersedes the original field-test instructions and the invite/timer recommendation above; the original text is preserved as the record of that investigation. The café verdict remains conditional on real field tests.

### Trigger and reproduction

The owner's first real run used two Linux laptops, Firefox 151 on both, on home Wi-Fi with the page hosted on HTTPS. B failed about 37 seconds before A applied the answer. A had camera permission and raw local candidates; B had mDNS candidates. Both reported an approximately 11.1-second ICE checking-to-failure interval. That demonstrates a broken test flow, but does not by itself identify the network cause.

The new harness drove the original page in separate Linux network namespaces on the open-LAN bridge, delaying **0, 5, 15, 30, 60 and 180 seconds after B's reply became available**. A is always the offerer. It ran all four Firefox/Chromium pairings, both with mDNS on A and with camera-style raw candidates on A: **48 trials, 42 connections and acknowledged 20 MiB transfers, 6 failures** [M].

| A → B | A mDNS, no camera | A raw candidates |
| --- | --- | --- |
| Firefox → Firefox | 0/5 s pass; 15/30/60/180 s fail | All six pass |
| Chromium → Chromium | All six pass | All six pass |
| Firefox → Chromium | All six pass | 0/5/15/30 s pass; 60/180 s do not open a data channel |
| Chromium → Firefox | All six pass | All six pass |

In the four failed Firefox-only mDNS cases, B was already `failed` before Connect, and A subsequently went from checking to failed in **11.102–11.103 seconds** [M]. In the two failed Firefox→Chromium raw cases, ICE was `connected` but the data channel stayed `connecting` through the 25-second post-Connect observation window [M]. An ICE success is therefore insufficient as the test's success criterion.

**The human-delay defect is reproduced; the owner's exact failure is not.** This lab has Firefox **157.0**, Chromium **156.0.8078.79**, one virtual interface per laptop, no Wi-Fi, and a loopback HTTP secure origin. Fake capture alone still yielded mDNS on Firefox, so its raw-A trials additionally disabled host obfuscation in browser preferences. They simulate raw candidates, not Firefox's actual camera-permission behavior. The raw Firefox-only cases survived 180 seconds here, unlike the owner's run. Firefox 151, mDNS resolution, interfaces/VPN, OS firewall, access-point behavior and hosted-origin permissions remain possible differences. We cannot conclude that timing was the sole cause on the owner's network.

### Alternatives actually tried

These are exploratory connection counts, not independent demonstrations of recovery: several cases already pass without a retry.

| Variant | Conditions | Data channel + 20 MiB |
| --- | --- | --- |
| Remove A's candidates and end-of-candidates before B applies the offer | Four pairings, two A modes, 30/180 s | 6/16; every Firefox answerer fails |
| Also explicitly advertise trickle ICE at media level | Firefox-only, two A modes, 30/180 s | 0/4 |
| Withhold, then add A's candidates to B when A connects | Four pairings, two A modes, 30 s | 4/8; adding after failure does not save Firefox |
| Call B's `restartIce()` before A uses the old answer | Same, 30 s | 7/8; expired Firefox-only mDNS case still fails |
| Call `createAnswer()` again on stable B | Same, 30 s | 0/8; all eight reject the call in the stable signaling state |
| Reapply the original offer to B, then generate/apply a fresh answer | Same, 30 s | 7/8; expired Firefox-only mDNS case still fails |
| Prepare B's answer but defer applying it until a final button | Firefox-only prototype, two A modes, 0/30/180 s | 6/6; taken forward into the page |

A separate two-engine probe also rejected gathering a temporary offer and rolling it back to construct the reply: Firefox changed its UDP port; Chromium changed both ICE credentials and port. Those gathered addresses cannot simply be reused as the eventual answer.

### Delivered flow and acceptance

B now calls `createAnswer()` while preparing the reply, **without calling `setLocalDescription`**. There are no B candidates in that reply. B waits with ICE and connection state `new`, then applies the prepared answer only on **Start connection**. B checks A's advertised candidates; A learns B's address from the incoming check. Copying either blob has no application deadline. This is a coordinated two-person test, with a short final start window, not an indefinitely valid unattended connection promise.

**The final order matters: A clicks Connect first; B clicks Start connection within one second.** A-first with a two-second gap failed 1/8 trials; B-first with a two-second gap failed 1/8 on open LAN (8/8 passed with typed addresses and multicast blocked). A wider B-first matrix failed all six Firefox→Chromium mDNS-A cells, although its other 90 cells passed. These rejected orders are retained, not counted as acceptance. In one A-first/two-second failure, Firefox exhausted its five-second candidate wait just before Chromium began checking. The UI now gives the explicit measured order instead of saying only “start together.”

The **final page passed 96/96 trials**, each transferring and acknowledging exactly **20 MiB** [M]:

- All four browser pairings × all six human delays × both A candidate modes: **48/48 on open LAN**.
- The same matrix with multicast blocked, B typing A's Wi-Fi address before the final clicks: **48/48**. B never has a camera; 24 of these trials have no camera on either laptop.
- In every acceptance trial, the harness waited **1,000 ms after A's Connect click before clicking B's Start connection**, plus automation overhead. This was not a zero-gap final handshake. B remained `new` throughout the preceding human wait.
- **28/28 UI/lifecycle checks** across Firefox and Chromium cover reset during gathering, closing the old peer, distinct retry IDs, stale/malformed replies, invalid typed addresses, two consecutive 20 MiB transfers, copied timestamps/delays, and an elapsed-time failure message when B never starts. A separate retained-harness smoke run (Firefox→Chromium, no cameras, multicast blocked, 15 s, A first by 1 s) also passed.

The page remains one file, with random-byte traffic only, no storage and no new default destination. Results now identify the attempt shared by A and B, with wall timestamps, monotonic event offsets, local ready-to-start delay, separate connection duration, and typed-address timing. **Start over** closes the old peer and camera stream and clears its result; callbacks from the old attempt cannot append to the new result. Copy before resetting. Browser failures and the 25-second page limit produce a plain elapsed-time message without diagnosing client isolation as fact.

**Typed-address instructions have changed.** On B, enter **A's** Wi-Fi IPv4 address after creating the reply and **before either final button**. The UDP port comes from A's invite. In an old-page multicast-blocked comparison, typing B's address on A after Connect passed all four immediate trials but failed both Firefox-answerer trials at 30 seconds: **6/8 overall**. A late address does not revive an already expired peer. The new page requires a fresh attempt after failure rather than offering that misleading recovery.

For a real rerun, use the page's instructions in place of steps 6–13 above: create A's invite, create B's reply, carry/paste it without rushing, optionally stage A's typed address on B, then count down with **A first and B within one second**. Copy both results before Start over. Retry with the typed address on a fresh attempt if discovery fails. No camera is necessary for that fallback.

### Consequences, evidence and limits

The original project-sync, convergence, throughput, chunking, fingerprint-tamper and disconnect measurements remain observations of **established connections under their original conditions**. They do not establish reliable human onboarding. Every earlier “manual” result, including compact invites and mesh joins, has an unmeasured human-delay gap. The original 8–10-second connection-ladder timer cannot run while a person carries a reply; nor should a timeout alone be reported as proof of network isolation. D3 now explicitly requires delayed exchange, start order, pre-start typed fallback, attempt identity and recovery acceptance. The compact invite format has not been remeasured with this flow.

The broad verdict still holds: direct sessions are an opportunistic transport, not backup, not a replacement for a relay, and not the encryption/membership design. This patch does not complete R6 or justify building D. **The owner's decision remains whether the real home rerun and venue evidence support D, and whether this coordinated interaction is acceptable.** Nothing was deployed or pushed.

[Raw timelines and results](data/collaboration/results/human-delay.json), [portable harness and exact variants](data/collaboration/scripts/human-delay-README.md), and [evidence verifier](data/collaboration/scripts/human-delay-verify.mjs) are retained. The JSON distinguishes final acceptance, baseline failures, rejected start orders, exploratory variants and preliminary runs. Initial harness mistakes (bad eval/regex, no-interface UI setup and a server shutdown race) were corrected and affected checks rerun; they are recorded separately from browser failures. No existing test was weakened or renamed.

Limits: single samples per matrix cell, headless Linux, concurrent contexts on one machine, no real radios or public HTTPS permission prompts. The UI suite uses raw candidates on a dummy interface. Delays beyond 180 seconds, tab throttling/sleep, Firefox 151, real camera behavior, real Safari/macOS/Windows, STUN/TURN and real firewall/isolation diagnoses remain unmeasured. Linux WebKit was optional and not run. `npm test`, WASM and application builds were not run: this change is confined to documentation, its standalone page and its measurement scripts. `scripts/ci-pages.mjs` is unchanged.

### R6a follow-up — scheduled starts and clock diagnosis

This follow-up supersedes the one-second click instruction above. The owner's next
real run used two Linux laptops, Firefox 151, home Wi-Fi, no camera and mDNS on
both. A clicked at 17:02:51.022 and failed at 17:02:56.031 without remote
candidates. B clicked at 17:03:07.041 and failed about five seconds later. The
apparent start gap is 16 seconds; the old result cannot rule out clock skew.
This is evidence of an unusable instruction, not evidence of network isolation.

The page now has one **Arm** click per laptop and automatic starts. A pastes the
reply, then arms for the next wall-clock multiple of 30 seconds at least 10
seconds away. A can choose a 30- or 60-second minimum before arming when one
person must walk between laptops. **A conveys the exact displayed UTC date/time
to B.** B can arm before receiving that time, or enter it first and then arm;
entering it into an already armed B needs no second click. B applies its answer
one second after that boundary. The local clock, UTC clock and countdown remain
visible. Both tabs must remain visible.

That extra time conveyance is necessary: with no signaling server, an already
armed B cannot know which future boundary A will choose after carrying the
reply. Independently choosing the next boundary on each laptop would quietly
reintroduce a race. The invite and reply remain outside the connection timer.
A missed boundary, including a tab that wakes more than one second late, gives a
plain missed-start message. Copy both results and **Start over on both laptops
with a fresh invite and reply**; the page never silently rolls one side forward
30 seconds or suggests rearming an expired peer.

Version 3 invites contain A's clock reading; replies contain B's reading and its
invite-receipt reading. Both results retain receipt times and apparent offsets
including carrying time. A also records the offset interval permitted by the
round trip, assuming clocks did not jump. Remote timestamps more than one second
in the future, or a round-trip interval incompatible with clocks within one
second, warn visibly. None of this measures exact skew: slow carrying can hide
it. Compare the live clocks before arming.

Failures record monotonic seconds waited, scheduled and actual local starts,
local and signaled remote mDNS/raw candidates, typed candidates, and remote
candidates observed through ICE statistics (including hidden addresses). A
scheduled remote start is explicitly **not proof of an actual remote start**.
After failure, paste the other copied result into **Compare results**. It checks
the attempt identity, records both sides' candidate evidence and actual starts,
and detects an apparent start gap of at least five seconds or a peer that never
started. Clock uncertainty remains explicit. A failed connection with candidates
is unresolved reachability; the page does not diagnose isolation.

Reapplying A's existing remote answer every three seconds did not extend the
16-second Firefox-only start gap (0/2 connections). Removing end-of-candidates
and adding trickle support to A's remote answer also gave 0/2. Both probes used
mDNS and raw A modes, zero carrying delay, and the previous page. Neither retry
is shipped; the one-second A-first gap retains the earlier measured success.

The final frozen page passed **48/48 connections and acknowledged 20 MiB
transfers**: four pairings × delays **0, 30 and 180 seconds** × both A candidate
modes × open LAN / multicast-blocked typed fallback. B stayed `new` throughout
carrying, armed before A, and received the exact shared boundary without another
Arm click. These are fresh trials, not the earlier 96 click-start records.
Delays 5, 15 and 60 seconds were not repeated on this page.

The final skew sweep uses all four pairings and both A modes, zero carrying
delay, and shifts **B's JavaScript Date only**. Positive means B's clock is ahead;
monotonic time and native timers remain unchanged. Every connected row also
received and acknowledged 20 MiB:

| B clock minus A | Target physical B–A start gap | Open LAN | Multicast blocked, typed on B |
| --- | --- | --- | --- |
| −5 s | +6 s | 4/8 | 4/8 |
| −2 s | +3 s | 7/8 | 8/8 |
| −1 s | +2 s | 7/8 | 8/8 |
| 0 s | +1 s | 8/8 | 8/8 |
| +1 s | 0 s | 7/8 | 8/8 |
| +2 s | −1 s | 7/8 | 8/8 |
| +5 s | −4 s | 6/8 | 8/8 |

**98/112 connect and transfer; 14 connection failures, no harness errors.**
All 16 matched-clock cells pass. There is **no established reliable symmetric
nonzero skew tolerance**: either sign of a one-second error already loses an
open-LAN pairing. Single samples do not establish a probability or a cutoff for
subsecond skew. Typed fallback tolerates all tested ±1/±2-second cells, but not
all ±5-second cells. The page therefore requires matching clocks rather than
promising that visible seconds prove synchronization. The JSON records actual
scheduled/apply times, timer lateness and the physical gap derived by subtracting
the injected offset; the target gap in this table is not a latency measurement.

Validation and failure accounting are retained in
[`wall-clock.json`](data/collaboration/results/wall-clock.json), alongside the
unchanged historical record. An early overlapping delay/skew run opened 48/48
and 99/112 connections but acknowledged only 46 and 30 transfers within the
unchanged 30-second observation window. These remain failed transfer trials.
With four contexts per pairing and no overlapping matrix, the exploratory skew
run acknowledged all its 99 connections. A subsequent candidate-page delayed
matrix passed 48/48; review then corrected comparison wording for a local peer
that had never started, and the entire delayed matrix was repeated on the
corrected page. The final suites run sequentially, and each run records the page
hash for the verifier. No test timeout was extended to get green.

**105/105 final UI checks pass** (35 each in Firefox, Chromium and Linux WebKit).
They preserve all earlier lifecycle/transfer checks and add early/late arming,
shared boundaries, live clocks, incompatible clock warnings, missed-start and
joint-result diagnosis, stale comparison rejection, timer cancellation and a
simulated late-tab refusal. Each engine opens a data channel and acknowledges
two 20 MiB transfers, then loads the standalone file and creates an invite
without additional observed resources. WebKit needs the retained Mesa software
renderer environment on this host; the initial default environment and two
partial environment retries failed before any page with an EGL display error.

The first expanded UI run exposed two new harness assumptions: Firefox does not
emit a Playwright request event for file navigation, and Chromium's typed-address
operation can outlive the click dispatch. The corrected checks assert no extra
observed resources and wait for typed completion; neither check was skipped.
That first run's partial Firefox/Chromium results and WebKit's 35 passes remain
in the preliminary record. The repeated full suite passes all 105. The pair
runner now also explicitly waits for typed completion. All existing final
matrix rows already record it before Arm; a further **1/1 Firefox→Chromium,
no-camera, multicast-blocked typed smoke** passes with the explicit driver wait.

The final retained-file verifier passes the 48 delayed rows, all 112 skew
outcomes, the portable smoke, four rejected-window probes, 105 UI checks and
matching final-page hashes. It also checks the unchanged historical 96-trial,
48-baseline and 28-UI records against the previous-page snapshot. This verifier
validates retained evidence; it does not launch new browsers. Exact commands,
counts, failed checks and reproduction instructions are in the
[updated harness README](data/collaboration/scripts/human-delay-README.md).

Limits remain one sample per condition, synthetic Linux networks and clock
shifts, headless browsers, and Firefox raw simulation through a preference.
This does not rerun Firefox 151, actual radios/firewalls, real camera permission,
public HTTPS permissions, Safari/macOS/Windows, or sleep/resume connectivity.
The late-tab check simulates a clock jump; matching visible seconds does not
establish subsecond skew. No WASM, application build, `npm test`, companion/folder
suite or deployment was run: only the standalone docs page and its harness
changed. No original UI check was removed; click-time expectations now use
armed, scheduled and applied timestamps.

These checks do not complete R6 or authorize milestone D. The owner's decision remains whether the real
home rerun and venue results justify D, and whether conveying the scheduled time
is acceptable. Nothing was deployed or pushed.

## Addendum: real network with real firewalls, 2026-11-05

**The first test on real hardware changes the verdict: with these machines' default firewalls, a manual copy-and-paste exchange only works if it finishes within a few seconds.** Earlier lab results did not show this, because the virtual laptops had no firewall.

The owner's goal is people collaborating on a shared network such as an office or home. Cafés were only an example, and getting around a network's restrictions is out of scope.

**Setup.** Two NixOS 26.05 machines on the same home Wi-Fi, both on wireless, each with the default NixOS firewall active, driven over SSH in headless Chromium 156 and Firefox 159 with temporary profiles. Nothing was changed on either machine. Pages were served through an SSH tunnel. Results and scripts are in [`data/collaboration/real-network/`](data/collaboration/real-network/). All 7 transfers in the matrix went over Wi-Fi: interface counters show 24–41 MB sent on Wi-Fi and under 1 MB on the mesh interface.

**Network checks, by hand.**

| Check between the machines | Result |
|---|---|
| One-way UDP over Wi-Fi, each direction | Dropped |
| One-way UDP over the mesh | Delivered |
| Ping over Wi-Fi | Works |
| `.local` name resolution through Avahi | Works |
| Both machines sending UDP at the same moment | Delivered immediately, both ways |

So the Wi-Fi does not isolate these machines. The evidence points to their firewalls dropping unsolicited UDP. The rules themselves could not be read without sudo.

**Connection and 20 MiB transfer, page where both sides send (one sample per cell, each pairing run in both machine directions).**

| Offerer → answerer | 0 s | 8 s | 20 s | 45 s | 90 s |
|---|---|---|---|---|---|
| Chromium → Chromium | 2/2 | 2/2 | 0/2 (1 opened, no transfer) | 0/2 | 0/2 |
| Firefox → Firefox | 2/2 | 0/2 | 0/2 | 0/2 | 0/2 |
| Chromium → Firefox | 1/2 (1 opened, no transfer) | 0/2 | 0/2 | 0/2 | 0/2 |
| Firefox → Chromium | 0/2 | 0/2 | 0/2 | 0/2 | 0/2 |

The delay is the time between creating the reply and applying it. Successful transfers ran at about 12–47 Mbit/s. A separate Chromium-only sweep connected and transferred in 16 of 22 trials, with failures scattered from 0 to 20 seconds and at 60 seconds, and one connection that opened and then dropped. One laptop slept during that sweep, so its later failures may not all be network effects. An earlier run failed at 15 seconds in both directions, and that did not repeat.

**What this means.**

- **The page's deferred-answer flow cannot work on these machines.** That flow delays the answerer, and only the answerer sends at first, so the offerer's firewall drops it. Two real runs failed this way. The version 3 page remains in the repository as a record but is not a usable route on a machine with such a firewall.
- **Both sides need to send at nearly the same time.** Ordinary WebRTC does this, and it is not a bypass: each machine opens its own connection, and it stops working if an administrator blocks that traffic.
- **The timing window is short and browser-dependent.** Firefox tolerated less than 8 seconds here. My inference, untested: firewalls keep a return path for a limited time after a machine last sent, and browsers stop sending after their ICE timeout, which together would explain why long delays fail.
- **Firefox → Chromium failed at every delay, and it is unexplained.** Chromium stayed in `new` and never began checks, which fits it failing to resolve Firefox's `.local` name, but that was not confirmed. Firefox → Firefox and Chromium → Firefox did connect at 0 seconds.

**What D therefore needs: an exchange that completes within seconds.** The owner chose option 1, the optional self-hostable connection service, on November 5, 2026, noting that a self-hosted server was always part of the plan. The options considered:

1. **Live signaling through an optional service**, such as opaque signaling in `scribyra-sync`. This is the most reliable, but the "no server" claim no longer holds for this route. A self-hosted office instance would keep it inside the organization.
2. **Scanning QR codes in both directions**, which may fit the window for two people at one table and needs cameras. Untested with real webcams.
3. **A person or administrator allowing the traffic in their own firewall.** This is their choice to make, and Scribyra should explain it plainly rather than attempt it.

**Limits.** One network, two NixOS machines, headless browsers, Firefox 159 rather than the owner's 151, one sample per cell. Windows, macOS and managed office machines may have different firewalls and were not tested. Real Safari remains unmeasured. The conclusions about firewalls are inferences from behaviour.

## Addendum: through the connection service, 2026-11-07

**With the self-hostable connection service, the same two machines connected directly in 26 of 32 trials, and the delays that broke the manual exchange no longer applied.** This is the route the owner chose for milestone D.

**Setup.** The same two NixOS machines, on the same Wi-Fi, with their default firewalls and nothing changed. Headless Chromium 156 and Firefox 159 with temporary profiles, driven over SSH. The milestone S service and its client ran on a third machine and reached both over SSH tunnels, so signaling did not cross the Wi-Fi, and that path is shorter than a hosted one would be on some networks and longer on others. ICE servers were empty. Results and scripts are in [`data/collaboration/real-network/service/`](data/collaboration/real-network/service/). All 26 transfers acknowledged 20 MiB over Wi-Fi, with at least 23 MB sent on Wi-Fi and under 40 KB on the mesh interface, at 12.5–48.2 Mbit/s, median 31.1.

| Offerer → answerer | Peer joins at once | Peer joins 20 s later | Time to open |
|---|---|---|---|
| Chromium → Chromium | 4/4 | 4/4 | 0.4–1.5 s |
| Chromium → Firefox | 4/4 | 4/4 | 3.3–3.7 s |
| Firefox → Firefox | 4/4 | 4/4 | 0.5–3.8 s |
| Firefox → Chromium | 1/4 | 1/4 | 3.4 s when it worked |

Each pairing ran in both machine directions. In this harness the offer is sent only after both have joined, so the 20-second case tests a late joiner and not a slow exchange.

**What this means for D.**

- **Live signaling solves the timing problem** that made manual exchange unusable on these machines.
- **Firefox → Chromium needs handling.** Six of eight failed with `ice:failed` on the Firefox side and Chromium's connection never leaving `new`, while the reverse direction passed 8 of 8. The cause is not established; failure to resolve Firefox's `.local` name is the leading guess. D should test having a Chromium peer make the offer when browsers are mixed, or retrying with roles swapped.
- **Firefox often takes about 3.5 seconds to open,** so a progress message is needed.

**Limits.** One network, two NixOS machines, headless browsers, Firefox 159, four samples per cell. The harness's first Firefox results were discarded because a WebDriver sandbox broke the page's binary handling; code then ran in the page itself. A self-hosted service on the same network, Windows, macOS, Safari and managed office machines were not tested. No document sync ran: this measures connection and transfer only.

