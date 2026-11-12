# MCP provider connections

> The Rust companion was discontinued on November 8, 2026. The editor now offers
> only direct HTTP providers; local stdio providers below remain documented for
> the test-only `localStorage['scribyra-companion-dev']` switch.

Goal 3b makes Scribyra an MCP client as well as an MCP server. The **Providers**
button connects an open project to HTTP providers directly from the static app,
or to configured local stdio providers through the optional Rust companion.
There is no built-in language model, account requirement or paid integration tier.

## Direct HTTP

Open **Providers**, choose **HTTP provider**, enter the full Streamable HTTP
endpoint and an optional bearer token, then select the provider capabilities you
want to use. Resource browsing is selected initially; tools and prompts are
separate grants. Tokens stay in this browser session. The endpoint must be HTTPS,
or HTTP on loopback. Credentials in the URL, query strings, fragments and
redirects are rejected. The client omits cookies and the editor referrer.

The provider must allow the editor's browser origin through CORS, including its
MCP request headers and any exposed session headers. Browser local-network rules
still apply to loopback connections from a hosted editor. A service that requires
a custom native transport, cookies, a redirecting endpoint or OAuth discovery is
not covered by this manual-bearer connection. This client does not turn the
companion into an arbitrary HTTP proxy or copy credentials to another origin.

The browser uses the official TypeScript client 2.4.0 and its Streamable HTTP
transport. Its automatic version negotiation supports the current `2026-07-28`
revision and legacy `2025-11-25` initialization. The SDK remains a separately
loaded static JavaScript chunk, included in the offline shell. The shared Rust
contract in `crates/core/src/providers.rs` also runs through WASM before requests
are sent. Reimplementing the protocol transport in Rust/WASM would duplicate the
maintained browser SDK without improving this integration boundary.

## Local stdio providers

Configure commands in a local JSON file, then start the companion with that file:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "references",
      "name": "My reference provider",
      "command": "node",
      "args": ["/absolute/path/to/provider.mjs"],
      "env": {},
      "cwd": "/absolute/path/to/provider-directory"
    }
  ]
}
```

```sh
npm run companion -- --providers /absolute/path/to/providers.json
```

`command` is an absolute executable path or an executable name resolved by PATH;
arguments are passed directly, without a shell. `cwd` and `env` are optional. Keep
configuration files with credentials private. No command starts merely because
the companion read its configuration. Pair the companion with the project, open
**Providers**, choose **Local provider via companion**, select a configured
provider, choose capabilities and connect. The browser cannot supply a command,
arguments, environment or working directory over this interface.

A local command runs as the companion's OS account; it is not sandboxed. Its
filesystem and network permissions come from that account and its configuration.
Scribyra's capability grant controls which MCP operations Scribyra sends, rather
than restricting what the configured program can do independently. Stderr is
discarded by this adapter; diagnose startup problems by running the configured
command directly in an appropriate local environment.

The child receives only PATH, SystemRoot, TEMP and TMP from the companion's
environment when present, plus explicitly configured environment entries. It does
not inherit the pairing code or arbitrary credentials from the companion process.
The Rust client uses rmcp 3.8.0 with explicit discovery/fallback for the current
`2026-07-28` and legacy `2025-11-25` lifecycles, MCP framing and cancellation,
and Tokio for owned process supervision. Native process ownership is separate from
SDK initialization so cancellation of an unfinished handshake can also stop and
reap its child. Disconnect closes the transport; a child that does not exit within
three seconds is killed and reaped. Companion shutdown waits for provider cleanup.
This manages the configured child process; a provider remains responsible for any
independent detached programs it launches.

The `/providers` API requires the browser credential from the original paired
Origin and an attached browser, rather than the separate MCP client credential.
Connections are bound to that pairing. Another project/pairing cannot invoke,
cancel or disconnect them. Pairing revocation is checked on every request and
again before returning a result. A native lifecycle sweep cancels detached/expired
pairings' provider work within approximately one second; completed external
actions cannot be reversed by revocation.

## Explicit operations and source disclosure

Each provider receives separate tools, resources and prompts permissions. The
closed Rust request schema accepts only these operations:

| Operation | Grant |
| --- | --- |
| `tools/list`, `tools/call` | Tools |
| `resources/list`, `resources/templates/list`, `resources/read` | Resources |
| `prompts/list`, `prompts/get` | Prompts |

The panel displays listings and schemas as data. Resource URIs are sent back to
the selected provider for reading; Scribyra does not fetch those URIs itself.
Use **Next page** when a listing returns a cursor. The HTTP SDK also bounds its
automatic listing aggregation to sixteen pages.

Enter a tool/prompt name and JSON arguments. **Attach active source as “source”
argument** copies a snapshot of the open text file into the local arguments field;
it sends nothing. **Review tool call** displays the exact provider, tool name and
arguments. Only **Send reviewed request** sends that reviewed snapshot. Editing
the arguments or changing providers invalidates the review. Cancelling a review
sends nothing. Resource reads and prompt retrieval are explicit panel actions.

Provider outputs are rendered with text content, including returned HTML,
instructions and links. They cannot execute code, issue another tool call, fetch
another URL, edit the project or widen permissions. Users may copy returned text
into their work; automatic source edits and provider-driven follow-up operations
are not part of this interface. No sampling, roots, elicitation, background tasks
or automatic interactive fulfilment is advertised or granted. Providers that
require those features return a limitation instead of receiving project access.

Credentials, connections, arguments and responses are device-session state. They
are not stored in Yjs, IndexedDB, source ZIPs or project history. Closing the panel
keeps established connections; disconnecting, closing/reloading the browser or
leaving the project ends them. Closing a panel while an operation is active
requests cancellation. Direct HTTP connections do not require the companion;
revoking the companion also closes providers that depend on it.

## Limits and failure semantics

The panel allows four connections per project. The native adapter allows four per
pairing, sixteen per process and sixteen configured definitions. There are at
most four requests per provider connection. Initialization has a twenty-second
limit; requests have a two-minute limit. Requests are bounded to 1 MiB, results to
8 MiB. The HTTP adapter bounds streamed response bytes as well as declared
Content-Length; the stdio codec separately caps incoming MCP frames at 16 MiB.
Large artifacts should be retrieved through provider-supported bounded resources.

The native adapter rejects reused request IDs and requires reconnecting after
4,096 requests; it does not evict IDs and then silently execute an old request
again. The app does not automatically retry an uncertain tool action. The SDK
handles protocol negotiation/corrective metadata exchanges. Cancellation is
cooperative: a lost response or cancelled request does not prove that the provider
rolled back an external effect. Inspect the provider's state before retrying.
Explicitly reconnect when a provider disconnects; the app does not restart a local
program or replay its actions automatically.

## Acceptance gate

Use a real independent MCP server over HTTP and stdio, plus a current-protocol
Rust server. Observe actual HTTP version headers. Verify capability denial before
transport, original-Origin/browser-credential enforcement, foreign pairing denial,
request replay rejection, cancellation and revocation during work. Check that
configured environment entries work without inheriting the pairing secret, and
that shutdown/cancelled initialization leave no live provider child.

In Chromium, Firefox and WebKit, exercise direct HTTP without a companion and
local stdio with one. Attach source locally, cancel a review without a remote
call, send the reviewed bytes, display malicious-looking content inertly, cancel
a slow call, restore dialog focus and audit accessibility. Export sources without
credentials/provider state and leave/reopen a project without retaining its
connections. Recheck existing inbound MCP, editor, shared-command and compiler/PDF
cancellation behavior before delivery. Use only public synthetic fixtures for
provider acceptance; never connect private papers to these fixtures.

Reproduce the checks with `npm test`, `npm run test:sync`, `npm run build`, then
`npx playwright test tests/browser/providers.spec.js tests/browser/companion.spec.js
tests/browser/editor.spec.js tests/browser/commands.spec.js tests/browser/runtime.spec.js
tests/browser/runtime-rollback.spec.js` (one shell command). The normal unit-test
script also builds the development-only modern stdio fixture.

Validation: the production WASM/static build, Rust formatting and release companion
build/CLI checks pass. The native suite passes **51 Rust tests**, and the final
JavaScript suite passes **132 tests**. Its provider cases use an independent
TypeScript SDK 1.32.2 server over real HTTP and stdio, and a real Rust server for
the current protocol. HTTP headers confirm the 2025 and 2026 revisions. A
modern-only stdio server rejects legacy initialization and confirms the actual
2026 metadata received on the tool request. Process
checks verify every recorded fixture PID is gone after companion shutdown,
including a provider cancelled before initialization completes.

The final browser regression matrix passes **36 cases** across Chromium, Firefox
and Linux WPE WebKit. Six exercise the new provider workflows; the remainder
recheck the inbound companion, editor, shared commands and actual browser
compilation/PDF cancellation. Browser checks cover reviewed source bytes, no calls
on cancelled review, inert returned HTML, actual remote cancellation, credential-
free source exports, accessibility/focus and project/pairing closure. A final
provider-only recheck covers the full endpoint shown in the consent review.
These are Linux acceptance results; other desktop operating systems remain release
validation work. No private paper was sent to a provider.

This completes the defined server/client MCP gate. Local folder/tab synchronization,
Git, provider-specific Zotero/plugin experiences and encrypted remote collaboration
retain their later roadmap milestones.
