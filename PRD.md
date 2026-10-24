# Speed-o'-Freq Sonic â€” Product Requirements Document (Draft 0.1)

**Status:** Research draft â€” awaiting product-owner answers  
**Date:** 2026-10-17  
**Initial target:** Windows 11 x64  
**Product type:** Desktop download manager with optional multi-network load balancing/bonding  
**Project directory:** `T:\Projects\Speed-o'-Freq Sonic`

## 1. Product vision

Speed-o'-Freq Sonic is a fast, trustworthy Windows download manager for personal use and eventual public release. It should make downloads easier to manage and, when the server and available network paths allow it, faster by using parallel segments and multiple independent internet connections.

The product must explain honestly what is being accelerated. Download segmentation, distributing separate connections across adapters, and true single-transfer multi-path bonding are different capabilities and must not be presented as interchangeable.

## 2. Problem statement

Users may have several network paths available at once (for example, home Wi-Fi plus USB-tethered mobile data or Ethernet plus a second independent ISP). Typical download managers provide queues, segmented downloads, resume and browser integration, but generally do not automatically combine separate network paths into a single end-to-end bonded transport.

The project aims to bring download management and network-path selection into one understandable Windows application, with transparent connection status, throughput telemetry, safety controls and recoverable downloads.

## 3. Target users and platform

- Primary user: project owner, on Windows 11.
- Secondary users: Windows users who want an approachable download manager and optionally have multiple independent internet connections.
- First release platform: Windows 11 x64; Windows 10 support is a later compatibility decision.
- Public distribution: signed/verified installer where feasible, clear privacy policy, software bill of materials and third-party license notices.

## 4. Product principles

1. **No false speed promises.** Actual results depend on server behavior, source limits, local storage, latency, packet loss and whether connections use independent upstreams.
2. **Safe network changes.** Never leave the system proxy or routes modified after stop, crash or failed startup. Provide recovery and a visible status.
3. **Download integrity first.** Resume must be validated; write chunks safely; verify final file size and hashes when a trusted hash is available.
4. **Local-first privacy.** No telemetry by default unless a future opt-in policy is explicitly approved.
5. **Minimal privilege.** The ordinary download manager should not require administrator rights. Elevation should be limited to network features that genuinely need it and clearly explained.
6. **Maintainable components.** Keep UI, download engine, adapter selection, scheduler and any bonding transport separated.
7. **License hygiene.** Audit each dependency and its distribution obligations before shipping an installer.

## 5. Core technical distinction

### 5.1 Segmented downloading
For servers that support HTTP byte ranges, request different file ranges concurrently and write them into the correct offsets. This can improve a single file's throughput if the server permits parallel requests and is not already the limiting factor. It must gracefully fall back to a single stream when ranges are unsupported or unsafe.

### 5.2 Connection-level load balancing
Bind separate TCP connections to specific network interfaces and distribute independent requests/downloads across those interfaces. This can improve aggregate throughput across multiple concurrent transfers, but a single TCP connection generally stays on one path. Application compatibility depends on proxy support or how the socket is bound.

### 5.3 True multi-path bonding
Split packets or a logical transport across multiple independent network paths and reassemble them at a coordinated endpoint. For ordinary internet destinations, this generally requires a relay/server, VPN-like tunnel, or compatible multipath protocol at both ends. This is the most ambitious feature and introduces server cost, security, privacy, latency, failure handling and operational complexity.

**Requirement:** The UI and documentation must clearly identify which mode is active. Never claim that two adapters are aggregating bandwidth merely because both are connected.

## 6. Research findings: candidate projects

These are representative candidates discovered and inspected on 2026-10-17. Repository activity and features can change. A README or author claim is not proof that a feature works on every Windows configuration; test code and builds before adopting any component.

### A. Download managers / engines

#### 1. AB Download Manager
- License reported by GitHub: Apache-2.0.
- Stack reported by repository metadata: Kotlin; multiplatform UI, Windows distribution and browser integrations.
- Documented strengths: modern desktop UI, queues/scheduler, browser extensions, free/open source; active development and large user community.
- Relevance: useful reference for Windows UX, onboarding, browser capture, queue organization and packaging.
- Limitation: it does not document true multi-interface bonding as a core feature. â€œFaster download speedâ€ usually refers to download-engine behavior, not a guarantee of multi-WAN bonding.
- Decision: study UX and browser handoff patterns; do not assume its code is a drop-in bonding engine.

#### 2. Motrix / Motrix Turbo
- Project states MIT licensing; repository API metadata returned NOASSERTION, so verify the current LICENSE and dependency notices before reusing code.
- Stack: current v2 project describes Electron, React, TypeScript, a separated download core and an MDXP JSON-RPC protocol; aria2 heritage/engine is central to the project.
- Documented strengths: HTTP/FTP/BitTorrent/magnet downloads, queue/session persistence, limits, tray, browser extension, CLI, plugin ecosystem, desktop and headless operation.
- Relevance: strong reference for separating UI from engine and designing a local API. Existing ecosystem could reduce the amount of download-management functionality we would need to invent.
- Limitations: v2 is described as beta in the inspected README. Multi-network bonding is not documented as a built-in feature. Validate current Windows build and maturity before relying on it.
- Decision: architecture/UX reference; possible integration candidate only after version, license and engine compatibility review.

#### 3. aria2
- License: GPL-2.0.
- Stack: native C++ command-line engine.
- Documented strengths: HTTP(S), FTP/SFTP, BitTorrent and Metalink; segmented downloads; multiple sources; speed limits; checksums/Metalink validation; JSON-RPC; daemon mode.
- Relevance: mature, proven download engine with a remote-control API and strong protocol support.
- Limitations: not a polished native GUI by itself. GPL-2.0 obligations may materially affect how the engine is distributed or combined with the product; obtain licensing review before bundling or linking. It does not itself create a universal bonded network.
- Decision: technically compelling engine candidate, but license compatibility is a gating decision.

#### 4. Persepolis Download Manager
- License: GPL-3.0.
- Stack: Python; frontend/wrapper around aria2.
- Documented strengths: multi-segment downloads, queues, scheduling, cross-platform GUI.
- Relevance: useful for feature comparison and aria2 integration UX.
- Limitations: older Python desktop stack relative to some current options; GPL-3.0 and its dependency chain need review. No documented true multi-path bonding.
- Decision: reference project, not first-choice code base pending maintenance and license review.

#### 5. Open Download Manager (ODM)
- Project describes itself as native GTK/Linux software combining aria2, yt-dlp and HTTrack.
- Documented strengths: unified queue, recovery, scheduling, proxies, media tools and website mirroring.
- Relevance: useful ideas for a durable job queue and multi-engine abstraction.
- Limitations: Linux-focused and not a direct Windows product foundation; several components have distinct licenses and behavior.
- Decision: reference only for queue/recovery design.

### B. Multi-network / bonding candidates

#### 6. Burst
- Repository created May 2026; metadata inspected on 2026-10-17 showed 10 stars, 0 forks and recent commits. README advertises Windows/Linux/macOS, a multi-interface download accelerator, libtorrent, adaptive chunk scheduling, browser extensions and pause/resume integrity checks.
- Relevance: the closest stated product concept found in this research: download manager plus multi-interface distribution and a visible chunk map.
- Important caution: the root API metadata did not identify a license, and a root LICENSE file was not found in the inspected listing, despite the README claiming MIT licensing. Resolve this discrepancy before copying or shipping any code. A young project and feature claims need independent build/code/test validation.
- Decision: inspect architecture and tests as a reference, not a dependency or verified benchmark.

#### 7. HypoMux
- License: AGPL-3.0.
- Stack: Python 3.10+, PySide6/Qt UI, Windows-focused.
- Documented design: local SOCKS5/HTTP proxy, interface-bound outbound sockets using Windows interface selection, round-robin connection distribution, adapter telemetry, and system-proxy integration.
- Relevance: directly relevant to Windows interface binding and per-connection load balancing. Source includes a proxy worker, proxy core, system-proxy module and test/prototype files.
- Limitations: README describes connection-level distribution, not a guaranteed single-stream bonded transport. It modifies the user's system proxy and requires administrator rights; failure to restore proxy state can disrupt connectivity. AGPL-3.0 may impose source-sharing obligations if distributed/modified or used in certain network-service arrangements.
- Decision: architecture study only unless the project license and system-proxy risk are accepted. Do not copy its code into a differently licensed product without legal review.

#### 8. Bonding (Donovoi)
- License: Apache-2.0; repository also contains a separate MIT license file, so determine which subcomponents each license covers.
- Stack: Rust workspace; Windows client using Wintun virtual interface, Linux-first server, encrypted UDP tunnel, path scheduler, packet reordering and replay protection.
- Documented modes: STRIPE, PREFERRED and REDUNDANT.
- Relevance: concrete example of a genuine packet-level bonding architecture with a client/server endpoint, encryption and path health monitoring.
- Limitations: still a small project (10 stars at inspection); requires a server reachable by the client, elevated privileges for the virtual adapter, and server-side forwarding/NAT setup. Windows server support is described as experimental. Needs threat-model and protocol review before production use.
- Decision: useful technical reference for a future bonding subsystem; not a turnkey end-user download manager.

#### 9. InternetMerge
- Stack: Go + Wails; local SOCKS proxy and per-connection interface binding; README describes macOS-first implementation with Windows/Linux support.
- Documented limitation: flow-based load balancing improves aggregate throughput for many independent transfers, but a single download does not become faster; true single-stream bonding with a relay is described as a future phase.
- Relevance: clear explanation of connection-level vs packet-level bonding and a cross-platform proxy architecture.
- Limitations: young/small repository (6 stars at inspection); no declared license was returned in repository metadata, so code reuse is blocked until clarified. Platform-specific interface binding and system-proxy behavior need validation.
- Decision: study architecture and technical claims, not reuse code until license and tests are verified.

#### 10. Network Smoothie
- License: MIT.
- Stack: Electron UI that wraps the separate dispatch-proxy project.
- Documented goal: easy UI for multi-adapter load balancing, including Wi-Fi plus tethering; old README notes pre-release status and backend inactivity.
- Relevance: illustrates a simple front-end over a proxy backend.
- Limitations: last source push reported in 2023; old backend/dependencies and maintenance gaps make it a weak foundation for a new public release.
- Decision: historical reference only.

#### 11. Combine-Network-Speeds
- Stack: Python script using psutil/requests and Windows route configuration.
- Documented behavior: distributes traffic across Wi-Fi and USB tethering by manipulating default routes and monitoring throughput; author explicitly states each TCP connection uses one adapter.
- Relevance: small, readable prototype for interface discovery and Windows routing concepts.
- Limitations: only a few commits, no declared license in repository metadata, administrator privileges required, route parsing/restoration can be fragile, and equal-metric route behavior is not a substitute for true bonding. README includes emergency reset commands that are undesirable as a consumer-product recovery strategy.
- Decision: conceptual reference only; do not use its routing approach as a production core.

#### 12. Speedify (commercial benchmark, not open-source code)
- Product: https://speedify.com/features/channel-bonding/
- Documented model: proprietary bonding VPN that distributes traffic across Wi-Fi, cellular, Ethernet and other paths, with an external Speed Server endpoint; includes speed, redundant and hybrid modes.
- Relevance: benchmark for genuine channel bonding, failover, traffic priority and UX.
- Limitation: proprietary service and server infrastructure; not a code base to reuse. Two interfaces leading to the same upstream do not create two independent internet capacities.
- Decision: use as a behavior/UX benchmark only.

## 7. Research synthesis

There is no single mature, clearly license-compatible, drop-in open-source project verified in this review that solves all of the following at once: polished Windows download manager, segmented downloads, browser integration, true single-transfer bonding across independent links, safe consumer-grade installer and production-ready server infrastructure.

The product can be built in stages:
- Use a reliable download engine or a well-tested native HTTP range-download implementation for ordinary download management.
- Implement interface discovery and **connection-level** balancing as a separate, explicitly labelled feature.
- Treat true packet-level bonding as a later subsystem with a documented protocol, encrypted tunnel, relay/server, operational budget and security review.

A sensible first implementation should not depend on fragile global route changes. Prefer explicit per-socket interface binding for downloads controlled by Sonic, and keep OS-wide proxy/VPN routing as a separately opt-in future feature.

## 8. Proposed MVP scope (pending owner approval)

### P0 â€” required for first usable release
- Add URL, choose destination/name, detect server filename when safe.
- Download queue with pause, resume, cancel, retry and reorder.
- Concurrent downloads and configurable segment count when server supports range requests.
- Progress, current speed, average speed, downloaded/total bytes, ETA and status.
- Persistent queue/history after app restart; atomic metadata updates.
- Safe resume using validators (ETag/Last-Modified where appropriate), range checks and final size validation.
- Per-download speed limits and global concurrent-download limit.
- Duplicate URL/file handling, conflict prompts and disk-space/error messages.
- Tray/minimize behavior only if the owner wants it.
- Local-only default, no telemetry by default.
- Installer/uninstaller, clean upgrade path, logs and a recovery-safe network layer.
- Baseline automated tests for HTTP range support, servers without ranges, redirects, expired URLs, disk errors, cancellation, app restart and corrupt/partial files.

### P1 â€” differentiating multi-network features
- Detect active physical interfaces and show name, type, link state, local address, route/Internet reachability, measured throughput and selection state.
- Allow the user to select interfaces for Sonic-managed downloads.
- Bind each parallel segment/connection to a selected interface where Windows APIs and server behavior permit.
- Scheduler adapts to path throughput/latency and avoids assigning work to dead/slow paths.
- Show per-interface usage and which path handled each segment/connection.
- Fallback safely if a selected adapter disappears.
- Clearly state that connection-level balancing does not guarantee one TCP stream uses all links.

### P2 â€” advanced / not assumed for MVP
- True packet-level multi-path tunnel with relay server.
- Account/server provisioning, usage limits, bandwidth and latency costs.
- Failover modes, per-app/system-wide routing, encrypted tunnel and reconnect behavior.
- BitTorrent/magnet support, browser extensions, download-from-clipboard, media extraction, mirror search, plugins, schedules, automatic updates, and multi-platform support.
- Any feature that downloads protected media or bypasses site access controls requires a separate lawful-use and security policy.

## 9. Candidate architecture to validate

- **Desktop UI:** select a Windows-native or cross-platform stack after owner answers UI and resource-use questions.
- **Download service:** isolated component with persistent task state, HTTP client, segment scheduler, resume validation, file assembly and integrity checks.
- **Adapter manager:** Windows interface discovery and health probes, no global route mutations by default.
- **Path-aware scheduler:** map each connection/segment to a selected interface; collect per-path throughput/latency/loss and reassign only unstarted work.
- **Optional bonding service:** isolated service for a later phase; virtual adapter/tunnel and relay must be separate from normal download management.
- **IPC:** authenticated local-only interface between UI and background engine; do not expose an unauthenticated local control port.
- **Persistence:** SQLite or equivalent transactional store for tasks/settings, plus atomic per-download metadata.
- **Packaging:** reproducible build, pinned dependencies, dependency/license inventory, signed release if feasible, minimal installer privileges and explicit uninstaller behavior.

The final technology choices should be made after deciding whether public distribution must remain permissively licensed and whether the bonding relay is acceptable.

## 10. Non-functional requirements

- No silent modification of Windows routing or proxy settings.
- If any system network setting is ever modified, save the exact previous value, show a visible status, restore it on every stop/error path, and provide a recovery action that does not require internet access.
- Never run downloaded files automatically.
- Treat URLs, redirects, filenames and server headers as untrusted input.
- Protect against path traversal, invalid filenames, overwriting files without consent, and maliciously large metadata.
- Bind any local API to loopback, require a random session token, and reject cross-origin/browser requests unless explicitly authorized.
- Keep logs useful but avoid storing URL credentials, cookies, authorization headers or personal data unnecessarily.
- No speed guarantee; report measured performance and mode accurately.
- Graceful handling of sleep/resume, network changes, low disk space, permission failures, long paths and shutdown.

## 11. Performance and acceptance tests

1. Single-source download: correct file hash/size, no corruption with segment counts 1, 2, 4 and configurable maximum.
2. Non-range server: automatically use a safe single-stream mode.
3. Interrupted transfer: pause/kill/restart resumes only validated byte ranges and produces correct final output.
4. Two independent paths: run a reproducible test with Wi-Fi and USB-tethered mobile data, measure each path alone and combined under the same server conditions.
5. Same upstream: UI must not claim additive bandwidth when Wi-Fi and Ethernet share one router/ISP.
6. Adapter loss: transfer either resumes on remaining path or pauses/retries with clear status, without corrupting output.
7. Proxy/route safety: no system proxy or route changes in default MVP; any later network mode must restore settings after crash, force quit, failed startup and uninstall.
8. No measurable UI freeze during high-throughput downloads.
9. Verify the installer works on a clean Windows 11 x64 environment without requiring a development toolchain.
10. Repeat benchmarks multiple times and report medians, not a cherry-picked best result.

## 12. Key risks and open technical decisions

- **True bonding needs an endpoint:** relay hosting, bandwidth costs, security and privacy policy must be decided.
- **Server restrictions:** range requests, connection limits, anti-bot rules, signed URLs and per-connection throttling may prevent acceleration.
- **Network policy:** carrier tethering limits, data charges, captive portals and NAT can affect the secondary link.
- **Licensing:** aria2/GPL, Persepolis/GPL, HypoMux/AGPL, Burst's missing/unclear license metadata and InternetMerge's missing declared license need review before reuse.
- **Stability/security:** adapter binding, Windows Firewall, virtual adapters, DNS, IPv4/IPv6 and proxy restoration are failure-prone.
- **Product scope:** download manager alone is feasible as an MVP; consumer-grade packet bonding is a significantly larger project.
- **Brand/name:** verify trademark, package name and domain availability before public launch; the working name is not yet legally cleared.

## 13. Owner questions required before the PRD can be finalized

1. Is the first release **Windows-only**, or must macOS/Linux be supported from the beginning?
2. For the first public release, is **connection-level balancing** acceptable as an initial step, or is true single-download packet-level bonding a non-negotiable launch requirement?
3. Are you willing to run/pay for a small relay/VPS server to make true bonding possible? If yes, should users bring their own server, or should Sonic eventually operate the service?
4. What is your intended source-code license: permissive open source (MIT/Apache-2.0), copyleft open source (GPL/AGPL), or proprietary/freeware? Can third-party license obligations shape the product?
5. Which sources must be supported first: direct HTTP/HTTPS files only, browser downloads, game launchers, BitTorrent/magnets, or media links? Please rank the top three.
6. How should browser capture work at launch: Chrome/Edge extension, Firefox extension, clipboard monitoring, drag-and-drop URL, or all of these?
7. Should the app only accelerate downloads it manages, or should it offer a system-wide mode for other apps too? System-wide mode requires additional risk and permissions.
8. Which network combinations must work: Wi-Fi + USB phone tethering, Wi-Fi + Ethernet, two Wi-Fi adapters, several ISPs, or all of them? Are the connections usually independent internet providers?
9. What UI style do you want: compact/functional, Windows 11 Fluent, or a more expressive Sonic-inspired high-speed visual identity? Dark mode only or dark/light?
10. Should the application be entirely free with no telemetry, or might optional donations, paid relay service, or premium features be acceptable?
11. Is a small background service and occasional administrator approval acceptable for network features, while keeping the normal download manager unprivileged?
12. What is the priority: fastest possible performance, lowest RAM/CPU use, simplest user experience, maximum privacy, or easiest maintenance? Choose your top two.

## 14. Research source index

- Speedify channel bonding overview: https://speedify.com/features/channel-bonding/
- Speedify multi-interface explanation: https://speedify.com/blog/combining-internet-connections/combine-wifi-ethernet-together-computer/

**Draft note:** This document records public repository documentation and metadata inspected on 2026-10-17. It is not a security audit, performance benchmark, legal opinion, or proof that third-party feature claims have been independently reproduced. The final PRD should be updated after owner answers and a local build/test review of any selected components.


---

# Owner Decision Update â€” 2026-10-17 (supersedes unresolved questions in Draft 0.1)

## A. Confirmed product decisions

| Area | Owner decision | Requirement / consequence |
|---|---|---|
| Operating system | Windows 10 and Windows 11 | Windows desktop app, x64-first unless owner approves ARM64 |
| Delivery strategy | Build both capabilities in stages | MVP download engine first; managed-download multi-interface scheduling next; system-wide features only after proof of safety and feasibility |
| Relay server | No | No mandatory Sonic-operated relay/VPS or recurring server subscription. Do not promise universal packet-level bonding without an endpoint |
| Distribution/license | Proprietary application | Keep Sonic's own source private. Audit every dependency's license and notices; permissive dependencies are easier to ship. Proprietary status does not waive third-party license obligations |
| Price | Free | No paid feature gate in the current plan. Hosting/relay costs cannot be assumed |
| Download sources | Direct files, browser downloads, game-related downloads, BitTorrent, media URLs | Prioritize direct HTTP(S) and robust queue/resume; browser capture comes later; torrent/media engines must be isolated modules and scoped legally/technically |
| Browser capture | Later | MVP accepts URLs via paste/open-with/drag-drop if feasible; browser extensions are a later milestone |
| Traffic scope | Managed downloads first; system-wide later | The first release may only accelerate traffic that Sonic itself opens and controls. System-wide acceleration is a separate privileged feature and must not be implied by the MVP |
| Network types | Wi-Fi + USB tether, Wi-Fi + Ethernet, multiple Wi-Fi adapters, multiple ISPs | Detect adapters and report actual usable paths. Only independent upstream capacity can normally add internet bandwidth; multiple adapters on one router may share the same bottleneck |
| Visual identity | Sonic-inspired high-speed design | Original blue/teal motion-inspired design language, fast-feeling but readable. Avoid copyrighted Sonic the Hedgehog characters/logos/art unless licensed |
| Top priorities | Performance and simplicity | Benchmark-driven engine, adaptive scheduling, few required settings, sensible automatic defaults |

## B. Revised product promise and technical terminology

Use the following product description:

> Speed-o'-Freq Sonic is a free Windows download manager that accelerates supported downloads using concurrent range requests, intelligent scheduling and multiple usable network interfaces, with a staged path toward broader traffic management.

Do not promise that all networks are always combined, that every download gets faster, or that two adapters connected to the same upstream ISP yield additive bandwidth.

### Mode 1 â€” Segmented download acceleration (P0)
Sonic requests supported byte ranges concurrently, validates responses, safely assembles the file and falls back to a single stream when range requests are unsupported or unsafe.

### Mode 2 â€” Multi-interface segmented downloads (P1)
Each independent HTTP range request is bound to a local interface address where Windows networking and the server permit it. A shared work queue lets faster paths take more chunks. This can aggregate capacity for a Sonic-managed file download without requiring a relay, because the file server itself serves the independent requests.

This is **application-layer multi-interface download scheduling**, not general-purpose packet-level bonding. It is the best fit for the owner's no-relay requirement.

### Mode 3 â€” System-wide traffic management (P2 / feasibility gate)
A local proxy can only affect apps that use it; a VPN/TUN-style system-wide tunnel typically needs a server/endpoint to route arbitrary internet traffic through a combined path. Without an endpoint, a universal system-wide packet-bonding promise is not realistic. Possible later features include per-app interface preference, per-connection route selection, or failover; each needs a separate technical prototype and clear limits.

### Mode 4 â€” True packet-level bonding
Not in the committed scope while the no-relay decision stands. Reopen only if the owner later approves a relay/compatible remote endpoint or a supported multipath protocol at the destination.

## C. Revised roadmap and acceptance gates

### Phase 0 â€” Engineering proof of concept (before committing to UI/engine)
- Enumerate Windows 10/11 network interfaces and determine each interface's local IP and route.
- Verify outbound HTTP(S) requests can be bound to each selected local address on the owner's actual machine.
- Test a public test file server that reliably supports HTTP Range requests.
- Compare Wi-Fi-only, USB-tether-only, and combined segmented downloads against the same file/source under repeatable conditions.
- Test Wi-Fi + Ethernet where both lead to the same router; label the result honestly and do not assume additive bandwidth.
- Test a path disappearing mid-download, redirects, TLS, range rejection, expired URLs, and server-side object changes.
- Produce a small benchmark report and a go/no-go decision before building a full UI.

### Phase 1 â€” Download manager MVP
- Direct HTTP/HTTPS downloads, task queue, pause/resume/cancel/retry, concurrent downloads, speed/ETA, speed limits, save location and conflict handling.
- Safe segmented downloads and fallback to one stream.
- Persistent queue and crash-safe resume.
- Windows 10/11 installer, uninstall/upgrade, logs and clear error messages.
- Sonic-inspired UI with conservative animation so rendering never degrades throughput or accessibility.
- No browser extension, torrent engine, system-wide tunnel, telemetry or relay in this phase unless separately approved.

### Phase 2 â€” Multi-interface download acceleration
- Interface selection and health monitoring.
- Per-interface throughput display and per-chunk path attribution.
- Dynamic chunk queue/work stealing; retry failed chunks without corrupting the output.
- Automatic selection and a simple manual override.
- Mobile-data warning and optional per-interface data cap.
- If server restrictions or Windows interface binding prevent a transfer, degrade safely and show the reason.

### Phase 3 â€” Additional sources and broader integration
- Browser capture extension (Chrome/Edge first; Firefox decision later).
- BitTorrent/magnet module after a library/license/security review.
- Game-launcher integration only where technically supported and permitted by the launcher; don't assume arbitrary launchers can hand their downloads to Sonic.
- Media URLs only for content the user is authorized to download and where the host permits it; no DRM circumvention or access-control bypass.
- Clipboard monitoring is opt-in and visibly controlled.
- System-wide/per-app routing prototype only after a written security and feasibility review.

## D. Candidate implementation strategy

- Keep the downloader core, Windows network-interface adapter, scheduler, UI, browser integration and protocol-specific engines separate.
- Build a small native or cross-platform core with clear contracts. Final language/framework selection is intentionally blocked pending owner confirmation and proof-of-concept results.
- Evaluate a native HTTP client and explicit local-address binding first. Avoid global route/proxy edits in the initial architecture.
- Use a transactional task database and per-download metadata. Write chunks to isolated temporary files or fixed, validated offsets; atomically rename only after validation.
- Make the scheduler adaptive using observed throughput and completion latency, but cap concurrency to avoid overloading servers and local CPU/storage.
- BitTorrent should be a separate module, not a requirement that dictates the entire download architecture.
- For system-wide mode, define a separate threat model and permissions boundary; do not run the normal UI/download engine as administrator merely for convenience.
- Public release requires dependency inventory, license/notice bundle, installer signing if practical, update integrity, uninstaller tests and clear privacy policy.

## E. Additional competitor finding: Sonic UI


This materially improves the candidate shortlist. Sonic UI should be examined as the first reference implementation for the Phase 0 proof of concept. It is not automatically approved for reuse: inspect the canonical upstream, current LICENSE, dependency licenses, release/build state, tests, Windows interface-binding implementation and security controls. Repository documentation is not independent proof of speed or correctness.



## F. Licensing and ownership requirements

The product is proprietary/freeware, but this does not mean every third-party component can be copied into it without conditions. Before adoption:
1. Verify the exact repository, commit/tag and license file.
2. Inventory direct and transitive dependencies and generated/bundled assets.
3. Reject code with absent/unclear licensing until clarified by its owner.
4. Review copyleft components (for example GPL/AGPL) with appropriate legal advice before linking, modifying or distributing.
5. Preserve required notices and source offers where applicable.
6. Keep proprietary application code separate from third-party components where practical.
7. Avoid reusing Sonic the Hedgehog character art, logos, music or trademarks without permission; create an original Sonic-inspired visual identity.

## G. Remaining critical owner decisions

The previous broad product questions are answered. The following are the remaining blockers before implementation:

1. **Development stack:** choose the preferred route: (a) C#/.NET with a Windows-native UI, (b) Rust core with a Windows UI, or (c) Electron/TypeScript. Recommendation: choose based on a short benchmark/prototype; avoid Electron if low idle RAM is a top requirement, and avoid selecting a language solely for familiarity.
2. **Machine architecture:** is the first release x64 only, or must ARM64 Windows be supported too?
3. **Windows 10 support baseline:** should we support all still-used Windows 10 builds, or only a defined minimum release? Windows 10's standard support ended in October 2025; any continued support needs a documented tested baseline and security expectations.
4. **System-wide scope:** given no relay, should Phase 3 mean per-app/interface selection and failover only, with true system-wide aggregation explicitly out of scope unless a compatible endpoint is later approved?
5. **Torrent priority:** is BitTorrent required for the first public release, or is it acceptable in Phase 3? This changes architecture, testing and dependency licensing materially.
6. **Media downloads:** should Sonic accept direct media file URLs only, or also supported webpage extractors? The latter brings a fast-changing dependency and greater site compatibility/legal burden.
7. **Game downloads:** name the first 2â€“3 game launchers or distribution platforms you want supported. General acceleration of proprietary launchers may not be possible without proxying or integration.
8. **Free-service funding:** if Sonic never operates a relay, free distribution is straightforward. If a relay is ever added later, who funds bandwidth and operations? For now the plan assumes no relay expense.
9. **UI detail:** dark-only or dark/light, and should the main view include a live per-interface chunk map or keep it optional to preserve simplicity?
10. **Telemetry:** confirm zero telemetry by default (recommended) and whether opt-in diagnostic logs may be exported by the user.

Do not start implementing system-wide bonding or integrate third-party engines until the Phase 0 proof of concept and license review pass.


## Owner Decision Update â€” 2026-10-17

The following decisions supersede conflicting open questions in earlier sections of this document.

### Confirmed decisions
- **Development stack:** undecided. Select only after a time-boxed technical spike compares a native Windows implementation with a Rust-based core/UI integration and other viable options. Evaluate throughput, per-interface socket binding, ARM64 support, memory/idle CPU, UI responsiveness, packaging, maintainability and dependency licensing.
- **Windows architecture:** support both **x64 and ARM64**. The release plan must build and test both architectures; every native dependency and installer component must be checked for ARM64 availability.
- **System-wide scope without relay:** **per-application interface selection and failover** only. Do not promise universal packet-level bonding or aggregate all arbitrary traffic without a compatible remote endpoint. Keep this phase separate from managed-download acceleration.
- **BitTorrent:** later phase, not MVP.
- **Media downloads:** both direct media URLs and supported webpage extraction, staged. Direct URLs first; extractors require a separately reviewed dependency, explicit supported-site scope, compatibility tests and policy/legal review.
- **Priority game platforms:** **Steam and Epic Games**. Initial work should be research and feasibility testing only; do not claim generic launcher acceleration until integration mechanisms and platform constraints are verified.
- **Theme:** both dark and light themes.
- **Diagnostics/telemetry:** no telemetry. Do not collect or transmit usage/diagnostic data. Local operational logs needed for troubleshooting must be minimal, user-accessible, and avoid secrets/URLs containing credentials; any future diagnostic export must be user-initiated and reviewed for sensitive data.

### Revised scope and implementation gates
1. **MVP:** Windows x64 + ARM64; original Sonic-inspired UI with dark/light themes; managed direct HTTP(S) downloads; segmented/range downloading when the origin supports it; per-interface binding and a shared chunk scheduler; pause/resume where validators and server behavior make it safe; local-only diagnostics; no telemetry, no relay, no torrent engine, and no browser capture.
2. **Media phase:** add supported webpage extraction after the extractor dependency, update cadence, license and site-terms posture are reviewed. Direct URL downloading remains the baseline.
3. **Per-app networking phase:** investigate app/interface selection and failover on Windows. Treat broad system-wide traffic aggregation as out of scope without a compatible endpoint. Use least-privilege mechanisms and do not install a kernel driver or network filter without a documented necessity, security review and explicit user consent.
4. **Later phases:** BitTorrent, browser capture, and launcher-specific integrations for Steam/Epic, each behind its own technical and licensing gate.

### Critical blockers to resolve before full implementation
- **License compatibility:** verify the exact current license and redistribution obligations for every candidate engine, extractor, native library, icon/font asset and bundled executable. Do not copy or link GPL/AGPL or unclear-license code into the proprietary product until compatibility has been reviewed and approved. Produce a dependency inventory and notice plan.
- **Interface binding proof:** demonstrate on the target Windows versions that separate HTTP range requests can reliably bind to selected local interface addresses, and define behavior when an interface disappears, changes address, uses VPN/NAT, or reaches the same upstream bottleneck.
- **Range correctness:** verify origin support for byte ranges, validators (ETag/Last-Modified), redirects, authentication, cookies, and servers that ignore or inconsistently honor Range. Unsupported servers must safely fall back to a single stream.
- **No-relay limitation:** document that per-download multi-interface scheduling is not universal internet bonding. Wi-Fi and Ethernet connected to the same router may share the same ISP bottleneck.
- **ARM64 dependency parity:** prove every selected engine, extractor and packaging dependency supports Windows ARM64 natively or has an acceptable fallback. Do not assume x64 emulation is sufficient for networking, driver or performance requirements.
- **Windows support baseline:** choose and test explicit Windows 10/11 minimum versions, including the security implications of Windows 10 standard support having ended in October 2025.
- **Third-party media extraction:** identify a maintainable, redistributable extractor and define supported sources. Review site terms, copyright/access-control constraints, update/signing risks and whether extraction can be isolated from the privileged/core process. No DRM or access-control circumvention.
- **Game platform feasibility:** determine what Steam and Epic permit and what interfaces are technically available. Do not intercept, modify or proxy launcher traffic, credentials, manifests or protected content without an authorized, supportable design.

### Next steps â€” Phase 0, research and proof of concept only
1. Create a dependency/license matrix for the shortlisted download engines and extractor candidates. Record license, version, transitive dependencies, native binaries, ARM64 availability, redistribution notices and unresolved legal questions.
2. Build a small throwaway network proof of concept (not the product UI) to enumerate adapters/local addresses, bind separate HTTP(S) requests to selected interfaces, request disjoint byte ranges, verify hashes, handle interface loss and compare throughput against one-interface and single-stream baselines.
3. Test against controlled servers covering range support, no-range fallback, redirects, ETag changes, throttling, failures, resume and cancellation.
4. Benchmark a minimal native UI/core spike in candidate stacks on x64 and ARM64. Choose the stack only after measurement and license review.
5. Write a Windows support matrix and threat model covering untrusted URLs, redirects to local/private addresses, credential storage, downloaded-file handling, updates/signing, permissions and local logs.
6. Run separate feasibility spikes for webpage media extraction and Steam/Epic integration; no production integration until the relevant gate passes.
7. Review results and make a go/no-go decision. **Do not begin full implementation, ship an installer, add a kernel driver, or integrate an unapproved third-party engine before these gates are closed.**

### Acceptance criteria for Phase 0
- Two independent interface-bound requests can be demonstrated on supported hardware; the test report records when aggregation helps and when it cannot.
- Downloaded output passes cryptographic hash verification; invalid or changed partial downloads are restarted safely rather than silently corrupted.
- Fallback works when range requests are unsupported or a selected interface fails.
- A reviewed dependency inventory establishes a viable proprietary redistribution path for both x64 and ARM64.
- A documented Windows baseline, security threat model, stack decision and explicit out-of-scope list are approved before product implementation.


## Research Update â€” Primary Product Goals and Reference Implementations (2026-10-17)

This section makes the project's defining goals explicit. It complements the owner decisions above; it does not authorize full implementation.

### Top-level product goals â€” in priority order
1. **Combine independent internet connections into one faster managed download.** This is the signature goal of Speed-o'-Freq Sonic. A single logical file should be fetched in disjoint chunks over eligible independent network interfaces (for example, Wi-Fi plus USB-tethered mobile data) and assembled into one final file. The UI must report total speed and per-interface contribution honestly.
2. **Prevent interrupted or failed downloads from becoming corrupt files.** Survive transient server errors, individual connection drops, interface disconnect/reconnect, app restarts and device sleep where feasible. Keep durable progress, retry recoverable work, validate server versions and never mark a partial or unverified file as complete.
3. **Maximize sustained throughput intelligently.** Use a shared work queue; measure useful throughput by network; let faster links consume more work; adapt concurrency to server, network and disk performance; avoid allowing a slow final chunk to hold the whole download where safe to race it.
4. **Make recovery understandable and controllable.** Show which networks are active, contribution per network, retries/failures, current state, and whether a limitation (no range support, server throttle, disk bottleneck, or unavailable route) prevents aggregation.
5. **Extend beyond managed downloads in controlled phases.** Browser capture, webpage media extraction, per-app interface selection/failover, Steam/Epic integrations and BitTorrent remain separate phases with their own technical, security and licensing gates.

### Definitions and honest product promise
- **Per-download multi-link aggregation (MVP target):** separate byte-range requests for one managed HTTP(S) download are bound to different local interfaces. A common scheduler coordinates chunks and produces a single output file.
- **Multiple connections to one server is not the same as multiple internet links.** Segmentation may help a server- or per-connection-limited download, but actual link aggregation additionally needs genuinely separate internet paths, an origin with sufficient capacity, and correct interface binding.
- **No relay means limits remain.** Sonic will not promise universal packet-level bonding, all-traffic aggregation or a speed multiplier for every download. A server may reject ranges, impose a total per-client limit, or be the bottleneck. Ethernet and Wi-Fi connected to the same home router normally share the same upstream connection.
- **Later system-wide/per-app option:** per-flow balancing can place different connections on different interfaces, but ordinarily does not split one arbitrary TCP flow between independent WANs. True seamless bonding of a single arbitrary flow normally requires compatible multipath support or an endpoint/relay. If a future per-app layer is investigated, label its scope accurately and design explicit failure/disable behavior.

### Download integrity and recovery requirements
- Keep a durable download manifest: URL/source identity with secrets stripped, expected length, accepted ETag/Last-Modified where supplied, chunk map, verified/durable progress, chosen networks, target/staging paths and safe state transitions. Treat persisted state as untrusted input and validate indices, ranges, sizes and paths when restoring it.
- Write to a staging/partial file and publish the final filename only after all required ranges are complete and validation succeeds. Prefer atomic rename when source and destination are on the same volume.
- Confirm that each HTTP response contains the expected status/range and exact byte interval. Reject malformed, overlapping, missing or overlong range data. If the server does not support ranges, safely fall back to one stream and report the loss of multi-interface aggregation for that download.
- Track file identity across requests. Use size and available validators (ETag/Last-Modified); if a remote resource changes mid-download, stop and re-probe/restart rather than silently combining different versions. Do not treat a changed validator alone as conclusive when origin/CDN behavior needs byte-level confirmation.
- Retry transient failures with bounded exponential backoff and respect Retry-After where appropriate. Distinguish a broken network path from a permanent response such as an authorization failure. Add timeouts for DNS, connect, response and stalled body; cancellation and pause must promptly stop active work.
- Checkpoint durable progress so process exit or power loss causes limited rework, not silent corruption. The exact checkpoint policy must be tested against disk flush semantics; never mark bytes durable merely because they arrived over the network.
- If a trustworthy expected checksum is supplied by the source, verify it before final publication. At minimum, the test suite must calculate SHA-256 of the source and output and require an exact match. A locally computed hash alone verifies the test result against its known source, not authenticity for arbitrary real-world downloads.
- Test corruption, truncation, duplicate/racing chunks, source mutation, expired URLs, redirects, disk-full/write failures, resume after restart, adapter loss, suspend/resume, cancellation, retry storms and malformed saved state. A download may never show 100%/Completed until correctness checks and final publication succeed.

### Reference-inspired implementation patterns
The current Sonic UI source tree includes distinct modules for HTTP probing, chunk transfer, block planning, adaptive scheduling, per-interface routing, persisted progress, source-version comparison and torrent handling. Its scheduler uses a shared pool of blocks and can race a slow final block only when no unclaimed block remains and the disk is not lagging. Its test guidance describes deterministic HTTP fault injection and byte-for-byte verification of completed downloads. Study these patterns as engineering references; do not copy source before reviewing the license and dependency inventory.

For Phase 0, the prototype should validate the core network engine and recovery contract before UI work. Proposed initial lab target: with a controlled range-capable origin and two independent shaped links, sustain at least 75% of the sum of the independently measured usable capacities when the origin and disk are not bottlenecks. This is a lab acceptance target, not a universal real-world promise; retain raw data and repeat with different link ratios, latency and failure timing.

### Licensing / implementation gate specific to Sonic UI
Sonic UI's repository license is MIT, which is generally compatible with proprietary distribution if the required copyright/license notice is preserved. This does **not** clear the entire Sonic UI application for reuse: its current package manifest lists Electron/Node/React/TypeScript-related components, WebTorrent, parse-torrent, fs-chunk-store, koffi and other dependencies with separate licensing, native packaging and supply-chain considerations. Audit the exact selected version's full lockfile/dependency graph, bundled binaries, patches and licenses. Decide separately whether to:
- study publicly described behavior only;
- selectively reuse MIT-licensed code with notices and a reviewed SBOM; or
- build an independent engine using the same high-level design principles.

Do not assume that the repository's MIT label automatically means every bundled component is approved for Sonic.

### Decision gate
Do not select the final stack or begin full application implementation yet. First produce a reproducible multi-interface range-download proof of concept, a fault-injection/resume test report, a complete dependency/license matrix for the candidate path, and a documented security/Windows support baseline. A high-throughput benchmark that does not also prove file integrity is a failed proof of concept.


## Phase 0 Execution Results â€” 2026-10-17

This section records actual tests run on the connected development machine. It is evidence from a local lab harness, not a production readiness claim.

### Environment observed
- OS: Windows 11 Pro, build 26300, x64 (confirmed through Win32_OperatingSystem; the general computer-info report labels it ambiguously).
- Installed tools: Python 3.14.7, .NET SDK 10.0.401 and 10.0.402, Git 2.55.0.
- Active physical internet adapter at test time: Intel Wi-Fi 6 AX201, IPv4 192.168.100.153. Intel Ethernet adapter was disconnected. Hyper-V virtual networking was present but is not evidence of an independent internet connection.
- Therefore, a genuine two-WAN throughput test could not be performed on this machine at this time.

### Tests passed
- Python standard-library harness: parallel HTTP Range downloads in 12 x 1 MiB chunks, injected HTTP 503 with retry, simulated partial-download checkpoint/resume, detection of a server that ignores Range, invalid progress metadata rejection, and SHA-256 match for the completed fixture.
- C#/.NET 10 socket probe: bound sockets to Wi-Fi IPv4 192.168.100.153; fetched 12 parallel HTTP ranges from a test server bound to the same local address; source/output SHA-256 matched exactly.
- C# probe compiled successfully for both win-x64 and win-arm64 runtime identifiers, with zero compiler warnings and errors.
- dotnet publish for the throwaway probe failed in the SDK publish target with MSB3094 (SourceFiles/DestinationFiles count mismatch). This packaging issue has not been diagnosed and means publish/installer readiness is **not** validated. It is not evidence that ARM64 compilation failed.

### What these results prove â€” and do not prove
- Proven: local range handling, concurrent chunk assembly, basic transient retry, checkpointed resumption in the harness, corrupt-state rejection, source-address binding to the active Wi-Fi address for a local server, identical hashes, and cross-RID compilation.
- Not proven: aggregation over two independent internet links; Windows routing to a remote server through each chosen NIC; link-loss recovery against a real external origin; throughput improvement over a single link; TLS/redirect/authentication edge cases; UI quality; installer packaging; ARM64 runtime execution on ARM hardware; Windows 10 support.
- Test artifacts and scripts are in the Phase0 directory. They are disposable research assets, not production downloader code.

### Stack recommendation (provisional, not a full implementation decision)
Prefer a **C#/.NET 10 core with a WPF UI spike** over adopting Sonic UI's Electron stack wholesale. Reasons: Windows is the product target, .NET provides socket/networking APIs and x64/ARM64 build support, the local C# binding/range probe passed, and a native WPF application avoids Electron's large packaged runtime. The WPF spike has now built and framework-dependent published for both target RIDs. Select C#/.NET 10 + WPF for the MVP, gated on Windows 10 compatibility and a real two-WAN acceptance test. The separate console-probe publish error remains to be diagnosed. Do not copy Sonic UI code or add a dependency merely to match its architecture.

### OS support decision still required
Microsoft lists Windows 10 Home/Pro standard support as ending on 14 October 2025; Windows 11 Home/Pro 26H2 is in support through 9 October 2028. The current development device reports Windows 11 build 26300. Keep Windows 10 as a compatibility target only if the project accepts an explicit warning that security updates require an eligible ESU/LTSC arrangement; test the exact target build and runtime before promising support. See the Microsoft lifecycle references in RESEARCH.md.

### Blockers still open after Phase 0
1. Obtain a second genuinely independent active WAN (for example, USB tethering using mobile data) and run a real external-origin test with byte ranges and a repeatable single-link baseline.
2. Diagnose the dotnet publish MSB3094 failure and verify a reproducible installer/package build for x64 and ARM64.
3. Execute the full HTTP protocol/failure matrix and review source mutation, redirects, auth, timeouts, disk-full, crash recovery and safe final-file publication.
4. Complete security review and dependency/license policy; use the audit register in Phase0/DEPENDENCY_LICENSE_AUDIT.md.
5. Identify the intended uMerge project via an exact URL or publisher. Exact-name web/repository searches did not find a relevant networking/download project.
6. Test the proposed WPF UI and runtime on actual ARM64 hardware and the agreed Windows 10 compatibility baseline.

**Gate status:** partial Phase 0 progress only. No production engine, browser capture, game integration, torrent engine, virtual adapter, driver, or installer has been implemented.


## Phase 0 Execution Results â€” 2026-10-17

- Environment: Windows 11 Pro build 26300 x64; Python 3.14.7; .NET SDK 10.0.401/10.0.402; Git 2.55.0.
- Active physical WAN: Intel Wi-Fi 6 AX201 at 192.168.100.153. Physical Ethernet was disconnected; Hyper-V virtual networking is not a second independent WAN. A genuine two-WAN benchmark could not be run.
- Python standard-library harness passed four checks: parallel HTTP Range download with injected 503/retry and exact SHA-256; checkpoint/resume after a simulated interruption; detection of a server ignoring Range; rejection of invalid saved progress.
- C#/.NET 10 socket probe bound to Wi-Fi IPv4 192.168.100.153 and fetched 12 concurrent HTTP ranges from a local server bound to that address. Source/output SHA-256 matched exactly.
- The C# probe compiled for win-x64 and win-arm64 runtime identifiers with zero warnings/errors. This proves cross-RID compilation only, not ARM64 runtime execution.
- dotnet publish for the disposable probe failed with SDK error MSB3094 (SourceFiles/DestinationFiles count mismatch). Packaging is unverified and the error must be diagnosed.

### Provisional stack recommendation
Evaluate C#/.NET 10 with WPF as the primary native Windows candidate. It aligns with a Windows-only product, builds for x64 and ARM64, passed the local socket/range probe, and avoids inheriting Electron's large runtime and Sonic UI's dependency graph. Do not finalize the UI/packaging choice until WPF and publish are validated and Windows 10 support is reconciled.

### Remaining Phase 0 blockers
1. Connect a second genuinely independent WAN (e.g. USB tethering using mobile data) and run the external-origin plan in Phase0/TWO_LINK_TEST_PLAN.md.
2. Diagnose the MSB3094 publish failure and verify packaging for both architectures.
3. Complete the protocol/failure matrix and production security review.
4. Review dependency and asset notices using Phase0/DEPENDENCY_LICENSE_AUDIT.md.
5. Identify the intended uMerge product by exact URL/publisher; exact-name searches did not find a relevant download/networking tool.
6. Test the proposed WPF UI and runtime on actual ARM64 hardware and the agreed Windows 10 baseline.

No production engine, browser capture, game integration, torrent engine, virtual adapter, driver, or installer has been implemented. These are Phase 0 findings only.


## WPF Stack Spike Addendum â€” 2026-10-17

- Generated a clean .NET 10 WPF template in Phase0/WpfSpike.
- WPF compiled for win-x64 and win-arm64 with zero warnings/errors.
- Framework-dependent WPF publish succeeded for both win-x64 and win-arm64.
- This establishes that the installed .NET SDK can build and publish a basic WPF shell for both target architectures. It does not establish runtime behavior on ARM64 hardware, Windows 10 compatibility, installer signing, or app-level networking correctness.
- The earlier MSB3094 publish error is isolated to the disposable console probe project; WPF publish succeeding means it should be debugged as a project/configuration issue rather than assumed to be a general .NET SDK limitation.

**Stack recommendation updated:** use C#/.NET 10 + WPF as the selected MVP stack, subject to the remaining Windows 10 compatibility and real two-WAN acceptance gates. Keep the networking core independent from UI code so the range scheduler and recovery logic can be tested without WPF.


## Stack decision update (2026-10-17)

Select C#/.NET 10 with WPF for the MVP, subject to Windows 10 compatibility and real two-WAN validation. The WPF spike compiled and published for x64 and ARM64. ARM64 runtime behavior remains untested on hardware.


The Phase 0 Range-unsupported check only observed and identified an HTTP 200 response to a Range request. Automatic single-stream fallback remains unimplemented and must be validated in the future engine; do not count it as passed.
