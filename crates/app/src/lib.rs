mod collaboration;
mod comments;
mod reviews;
mod review_workspace;
mod history;
use leptos::prelude::*;
use leptos::tachys::html::attribute::custom::CustomAttribute;
use serde::Deserialize;
use wasm_bindgen::{JsCast, prelude::*};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = scribyra)]
    fn action(name: &str, value: &str);
    #[wasm_bindgen(js_namespace = scribyra)]
    fn ready();
    #[wasm_bindgen(js_namespace = scribyra)]
    fn composing() -> bool;
}
#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct State {
    comments: comments::State,
    reviews: reviews::State,
    review_workspace: review_workspace::State,
    history: history::State,
    side_panel: String,
    tabs: Vec<File>,
    search_query: String,
    search_replacement: String,
    search_case: bool,
    search_whole: bool,
    search_regex: bool,
    search_scope: String,
    search_busy: bool,
    search_stale: bool,
    search_results: Vec<SearchHit>,
    search_status: String,
    search_truncated: bool,
    undo_replace_label: String,
    outline_items: Vec<Heading>,
    outline_scope: String,
    outline_busy: bool,
    outline_status: String,
    projects: Vec<Card>,
    files: Vec<File>,
    tree: Vec<TreeRow>,
    selected: String,
    trash_count: usize,
    tree_error: String,
    current: bool,
    name: String,
    active: String,
    main_file: String,
    engine: String,
    busy: bool,
    status: String,
    save_status: String,
    sync_status: String,
    companion_status: String,
    tab_sync_status: String,
    recovery_available: bool,
    upgrade_available: bool,
    notice: String,
    log: String,
    show_log: bool,
    show_issues: bool,
    build_issues: Vec<scribyra_core::diagnostics::Issue>,
    auto: bool,
    has_pdf: bool,
    pdf_page: usize,
    pdf_pages: usize,
    pdf_scale: usize,
    pdf_find_open: bool,
    pdf_query: String,
    pdf_case: bool,
    pdf_whole: bool,
    pdf_find_count: usize,
    pdf_find_status: String,
    pdf_error: String,
    source_map_ready: bool,
    source_map_busy: bool,
    source_map_status: String,
    stale: bool,
    storage: String,
    peers: usize,
    plaintext_demo: bool,
    direct_enabled: bool,
    direct_active: bool,
    /// Test-only switch for the discontinued Rust companion; see web/main.js.
    companion_dev: bool,
    mac_platform: bool,
    download_loaded: f64,
    download_total: f64,
    filter: String,
}
#[derive(Clone, Default, Deserialize)]
struct SearchHit {
    index: usize,
    path: String,
    line: usize,
    column: usize,
    preview: String,
}
#[derive(Clone, Default, Deserialize)]
struct Heading {
    index: usize,
    path: String,
    line: usize,
    level: usize,
    title: String,
}
#[derive(Clone, Default, Deserialize)]
struct Card {
    id: String,
    name: String,
    files: usize,
    date: String,
}
#[derive(Clone, Default, Deserialize)]
struct File {
    id: String,
    path: String,
    #[serde(default)]
    binary: bool,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct TreeRow {
    id: String,
    path: String,
    name: String,
    binary: bool,
    folder: bool,
    depth: usize,
    expanded: bool,
    position: usize,
    siblings: usize,
}

#[component]
fn Icon(#[prop(default = "file")] name: &'static str) -> impl IntoView {
    let d = match name {
        "plus" => "M12 5v14M5 12h14",
        "arrow" => "M5 12h14m-5-5 5 5-5 5",
        "back" => "M19 12H5m5-5-5 5 5 5",
        "folder" => "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z",
        "upload" => "M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5",
        "download" => "M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4",
        "sun" => {
            "M12 3v1m0 16v1M3 12h1m16 0h1M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0"
        }
        "play" => "m9 5 11 7-11 7Z",
        "check" => "m5 12 4 4L19 6",
        "search" => "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
        "share" => {
            "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-4M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0m4-3a4 4 0 0 1 0 8"
        }
        "lock" => "M5 10h14v11H5ZM8 10V7a4 4 0 0 1 8 0v3",
        "more" => "M5 12h.01M12 12h.01M19 12h.01",
        "terminal" => "m5 5 6 6-6 6m8 0h6",
        "pencil" => "M4 20l1-4L16 5l3 3L8 19ZM14 7l3 3",
        "track" => "M4 7h8M4 12h8M4 17h16M17.5 4v7M14 7.5h7",
        "eye" => "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
        "comment" => "M4 5h16v11H10l-4 4v-4H4Z",
        "chevron" => "m7 10 5 5 5-5",
        "to-pdf" => "M7 7l10 10M17 9v8H9",
        "to-source" => "M17 17 7 7M7 15V7h8",
        "fit-width" => "M3 12h18M7 8l-4 4 4 4m10-8 4 4-4 4",
        "fit-page" => "M7 3h10v18H7Z",
        "minus" => "M5 12h14",
        "page-previous" => "m15 6-6 6 6 6",
        "page-next" => "m9 6 6 6-6 6",
        "plug" => "M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0Zm6 9v4",
        "servers" => "M4 5h16v5H4Zm0 9h16v5H4Zm4-6.5h.01M8 16.5h.01",
        "package" => "m12 3 8 4.5v9L12 21l-8-4.5v-9Zm0 9 8-4.5M12 12v9m0-9L4 7.5",
        "sliders" => "M4 7h9m5 0h2M4 17h2m5 0h9M13 5h5v4h-5Zm-7 10h5v4H6Z",
        "pulse" => "M3 12h4l3-7 4 14 3-7h4",
        "flag" => "M5 21V4m0 1h12l-3 4 3 4H5",
        "shield" => "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z",
        "scroll" => "M7 3h11v18H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm3 5h5m-5 4h5",
        _ => "M14 2H5v20h14V7Zm0 0v5h5M8 12h8m-8 4h8",
    };
    view! { <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=d/></svg> }
}

// DOM relationships must remain valid even for imported non-UUID identifiers.
fn dom_id(prefix: &str, id: &str) -> String {
    format!(
        "{}-{}",
        prefix,
        id.as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

// Secondary compile settings live behind the split button so the toolbar stays calm.
#[component]
fn CompileOptions(auto: Signal<bool>, preview: Signal<bool>) -> impl IntoView {
    view! {
        <div class="compile-options">
            // web/menu.js owns open and close, as it does for every popup.
            <button class="compile-caret" aria-label="Compile options" title=move || match (auto.get(), preview.get()) {
                (true, true) => "Compile options: Auto and suggestion preview on",
                (true, false) => "Compile options: Auto on",
                (false, true) => "Compile options: suggestion preview on",
                _ => "Compile options",
            } aria-controls="compile-options-menu" aria-expanded="false" data-active=move || (auto.get() || preview.get()).to_string()><Icon name="chevron"/></button>
            <div id="compile-options-menu" class="compile-options-menu" role="group" aria-label="Compile options" hidden=true>
                <label class="compile-option"><input type="checkbox" aria-label="Auto" aria-describedby="compile-auto-hint" prop:checked=move || auto.get() on:change=move |_| action("auto", "")/><span><strong>"Auto"</strong><small id="compile-auto-hint">"Recompile when the source changes"</small></span></label>
                <label class="compile-option"><input type="checkbox" aria-label="Preview with suggestions" aria-describedby="compile-preview-hint" prop:checked=move || preview.get() on:change=move |_| action("review-preview-toggle", "")/><span><strong>"Preview with suggestions"</strong><small id="compile-preview-hint">"Compile a separate PDF with pending changes applied"</small></span></label>
            </div>
        </div>
    }
}

#[component]
fn App() -> impl IntoView {
    let (s, set_s) = signal(State::default());
    let (page_editing, set_page_editing) = signal(false);
    let (page_draft, set_page_draft) = signal(String::new());
    let callback =
        Closure::<dyn Fn(web_sys::CustomEvent)>::new(move |event: web_sys::CustomEvent| {
            if let Some(json) = event.detail().as_string() {
                if let Ok(state) = serde_json::from_str::<State>(&json) {
                    if !state.current || state.pdf_pages == 0 {
                        set_page_editing.set(false);
                    }
                    set_s.set(state);
                }
            }
        });
    web_sys::window()
        .unwrap()
        .add_event_listener_with_callback("scribyra:state", callback.as_ref().unchecked_ref())
        .unwrap();
    callback.forget();
    ready();
    view! {
        <div class="app-shell">
            <Show when=move || !s.get().current fallback=move || view! {
                <header class="editor-header">
                    <button class="icon-button back-button" title="All projects" aria-label="All projects" on:click=move |_| action("home", "")><Icon name="back"/></button>
                    <span class="brand-mark small">"s"</span><span class="header-divider"></span>
                    <button class="project-title" title="Rename project" on:click=move |_| action("rename-project", "")>{move || s.get().name}</button>
                    <span class="save-indicator">{move || s.get().save_status}</span>
                    <div class="header-spacer"></div>
                    <Show when=move || s.get().upgrade_available><button class="button secondary compact" on:click=move |_| action("upgrade-project", "")>"Export before updating"</button></Show>
                    <Show when=move || s.get().recovery_available><button class="button secondary compact recover-button" title="Save recovered copy" on:click=move |_| action("recover-project", "")>"Save recovered copy"</button></Show>
                    <span id="direct-participants" role="group" aria-label="Direct participants"></span>
                    // Direct sessions are experimental and off by default: More tools always reaches Share,
                    // and the top-bar button appears only once the person has turned them on.
                    <button id="direct-share-toggle" class="button secondary compact" aria-haspopup="dialog" aria-expanded="false" hidden=move || !(s.get().direct_enabled || s.get().direct_active) on:click=move |_| action("direct-share", "")><Icon name="share"/>"Share"</button>
                    <history::History state=Signal::derive(move || s.get().history)/>
                    // The plaintext demo appears only behind its explicit development switch; see README.
                    <Show when=move || s.get().plaintext_demo><button class="button secondary compact" title="Sync demo: share this project with another tab" on:click=move |_| action("sync", "")><Icon name="share"/>{move || if s.get().peers > 0 { format!("{} connected", s.get().peers + 1) } else { "Sync demo".into() }}</button></Show>
                    <button class="button secondary compact" title="Export project" on:click=move |_| action("export", "")><Icon name="download"/>"Export"</button>
                    <div class="header-tools">
                        <button class="icon-button" aria-label="Toggle theme" title="Toggle theme" on:click=move |_| action("theme", "")><Icon name="sun"/></button>
                        // web/menu.js owns open and close, as it does for every popup.
                        <button class="icon-button tools-toggle" aria-label="More tools" title="More tools" aria-controls="more-tools-menu" aria-expanded="false" data-active=move || (s.get().companion_dev && s.get().companion_status.starts_with("Connected")).to_string()><Icon name="more"/></button>
                        <div id="more-tools-menu" class="tools-menu" role="group" aria-label="More tools" hidden=true>
                            <button aria-label="Project settings" on:click=move |_| action("editor-settings", "")><Icon name="sliders"/><span>"Project settings"</span></button>
                            <button aria-label="TeX environment" disabled=move || s.get().busy on:click=move |_| action("tex-environment", "")><Icon name="package"/><span>"TeX environment"</span></button>
                            <button aria-label="Diagnostics" on:click=move |_| action("diagnostics", "")><Icon name="pulse"/><span>"Diagnostics"</span></button>
                            <hr/>
                            <button aria-label="Share project" aria-haspopup="dialog" on:click=move |_| action("direct-share", "")><Icon name="share"/><span class="tools-item-text">"Share project"<small>{move || if s.get().direct_active { "Experimental · in a direct session" } else if s.get().direct_enabled { "Experimental · direct sessions on" } else { "Experimental · off" }}</small></span></button>
                            <hr/>
                            <button aria-label="MCP providers" on:click=move |_| action("providers", "")><Icon name="servers"/><span>"MCP providers"</span></button>
                            // The Rust companion is discontinued (November 8, 2026). Its item exists only behind
                            // the test-only localStorage switch scribyra-companion-dev; see web/main.js.
                            <Show when=move || s.get().companion_dev><button aria-label="Rust companion and MCP" title=move || format!("Companion: {}", s.get().companion_status) data-connected=move || s.get().companion_status.starts_with("Connected") on:click=move |_| action("companion", "")><Icon name="plug"/><span class="tools-item-text">"Rust companion and MCP"<small>"Discontinued; test builds only"</small></span></button></Show>
                            <hr/>
                            <button aria-label="Report a problem" on:click=move |_| action("report", "")><Icon name="flag"/><span>"Report a problem"</span></button>
                            <a href="https://scribyra.com/privacy.html" target="_blank" rel="noopener"><Icon name="shield"/><span>"Privacy"</span></a>
                            <a href="https://scribyra.com/licenses.html" target="_blank" rel="noopener"><Icon name="scroll"/><span>"Licences"</span></a>
                        </div>
                    </div>
                </header>
                <div class="workspace">
                    <history::HistoryView state=Signal::derive(move || s.get().history)/>
                    <aside class="file-sidebar">
                        <nav class="workspace-navigation" aria-label="Workspace tools">
                            <button aria-label="Files" aria-pressed=move || (s.get().side_panel == "files").to_string() on:click=move |_| action("workspace-panel","files")>"Files"</button>
                            <button aria-label="Search project" aria-pressed=move || (s.get().side_panel == "search").to_string() on:click=move |_| action("workspace-panel","search")><Icon name="search"/>"Search"</button>
                            <button aria-label="Document outline" aria-pressed=move || (s.get().side_panel == "outline").to_string() on:click=move |_| action("workspace-panel","outline")>"Outline"</button>
                        </nav>
                        <Show when=move || s.get().side_panel == "files">
                        <div class="sidebar-heading"><span>"PROJECT FILES"</span><button class="icon-button" aria-label="Add folder" title="Add folder" on:click=move |_| action("add-folder", "")><Icon name="folder"/></button><button class="icon-button" aria-label="Add file" title="Add file" on:click=move |_| action("add-file", "")><Icon name="plus"/></button></div>
                        <button class="tree-root" on:click=move |_| action("select-root", "")>"Project root"</button>
                        <div class="file-list" id="project-tree">
                            <div class="composite-owner" role="tree" aria-label="Project files" aria-owns={move || s.get().tree.iter().map(|n|dom_id("tree",&n.id)).collect::<Vec<_>>().join(" ")}></div>
                            <For each=move || s.get().tree key=|f| (f.id.clone(), f.path.clone(), f.depth, f.position, f.siblings) children=move |f| {
                                let id = f.id.clone(); let active_id = id.clone(); let menu_id = id.clone(); let focus_id = id.clone(); let selected_id = id.clone();
                                let folder = f.folder; let expanded_id = id.clone(); let symbol_id = id.clone();
                                let tree_button = view! { <button class="file-open" role="treeitem" id=dom_id("tree",&id) draggable="true" data-node=id.clone() aria-label=f.path.clone() title=f.path.clone()
                                        aria-posinset=f.position.to_string() aria-setsize=f.siblings.to_string()
                                        aria-selected=move || (s.get().selected == selected_id).to_string()
                                        aria-expanded=move || if folder { Some(s.get().tree.iter().find(|n| n.id == expanded_id).is_some_and(|n| n.expanded).to_string()) } else { None }
                                        tabindex=move || if s.get().selected == focus_id || (s.get().selected.is_empty() && s.get().tree.first().is_some_and(|n| n.id == focus_id)) { "0" } else { "-1" }
                                        on:click=move |_| action("select-node", &id)>
                                        <span class="file-symbol" aria-hidden="true">{move || if folder { if s.get().tree.iter().find(|n| n.id == symbol_id).is_some_and(|n| n.expanded) { "▾" } else { "▸" } } else if f.binary { "◈" } else { "" }}<Show when=move || !folder && !f.binary><Icon/></Show></span><span class="file-path">{f.name}</span>
                                    </button> }.attr("aria-level", f.depth.to_string());
                                view! { <div class=move || if s.get().selected == active_id { "file-row active" } else { "file-row" } style=format!("padding-left:{}px", (f.depth.saturating_sub(1)) * 14)>
                                    {tree_button}
                                    <button class="file-menu icon-button" aria-haspopup="menu" aria-expanded="false" aria-label=if folder { "Folder actions" } else { "File actions" } title="Rename, move or delete" on:click=move |_| action("file-menu", &menu_id)><Icon name="more"/></button>
                                </div> }
                            }/>
                        </div>
                        <Show when=move || !s.get().tree_error.is_empty()><p class="tree-error" role="alert">{move || s.get().tree_error}</p></Show>
                        <button class="upload-files" on:click=move |_| action("upload-files", "")><Icon name="upload"/>"Upload files"</button>
                        <button class="upload-files" on:click=move |_| action("import-folder", "")><Icon name="folder"/>"Import folder"</button>
                        <Show when=move || { s.get().trash_count > 0 }><button class="upload-files" on:click=move |_| action("restore-deleted", "")>"Restore last deletion"</button></Show>
                        </Show>
                        <Show when=move || s.get().side_panel == "search"><SearchPanel s=s/></Show>
                        <Show when=move || s.get().side_panel == "outline"><OutlinePanel s=s/></Show>
                        <div class="sidebar-bottom"><Icon name="lock"/><p>"Your words stay yours."<br/><span>"Saved on this device."</span></p></div>
                    </aside>
                    <section class="writing-area" aria-label="LaTeX workspace" data-review-mode=move || s.get().review_workspace.mode>
                        <div class="workspace-toolbar">
                            <review_workspace::Mode state=Signal::derive(move || s.get().review_workspace)/>
                            <div class="header-spacer"></div>
                            <div class="compile-controls">
                            <label class="engine-label"><span class="sr-only">"Compiler"</span><select aria-label="Compiler" prop:value=move || s.get().engine on:change=move |e| action("engine", &event_target_value(&e))><option value="lualatex">"LuaLaTeX"</option></select></label>
                            <select aria-label="Main document" title="Main document" prop:value=move || s.get().main_file on:change=move |e| action("main-file", &event_target_value(&e))>
                                <For each={move || s.get().files.into_iter().filter(|f| f.path.to_ascii_lowercase().ends_with(".tex")).collect::<Vec<_>>()} key=|f| (f.id.clone(), f.path.clone()) children=|f| view! { <option value=f.id>{f.path}</option> }/>
                            </select>
                                <button class="button secondary compact compile-cancel" hidden=move || !s.get().busy on:click=move |_| action("compile-cancel", "")>"Cancel compilation"</button>
                                <div class="compile-split">
                                    <button class="button primary compile-button" disabled=move || s.get().busy aria-busy=move || s.get().busy.to_string() data-state=move || if s.get().busy { "running" } else { "idle" } on:click=move |_| action("compile-start", "")><Icon name="play"/>"Compile"<kbd aria-hidden="true">{move || if s.get().mac_platform { "⌘ ↵" } else { "Ctrl ↵" }}</kbd></button>
                                    <CompileOptions auto=Signal::derive(move || s.get().auto) preview=Signal::derive(move || s.get().review_workspace.preview)/>
                                </div>
                            </div>
                        </div>
                        <div class="split-panes" id="split-panes">
                            <section class="source-pane">
                                <div class="editor-tab">
                                    <div class="composite-owner" role="tablist" aria-label="Open files" aria-owns={move || s.get().tabs.iter().map(|f|dom_id("tab",&f.id)).collect::<Vec<_>>().join(" ")}></div>
                                    <For each=move || s.get().tabs key=|f| (f.id.clone(),f.path.clone()) children=move |f| {
                                        let id=f.id.clone();let selected=f.id.clone();let focus=f.id.clone();let close=f.id.clone();
                                        view!{<div class="file-tab"><button role="tab" id=dom_id("tab",&f.id) aria-controls="code-editor" aria-selected=move || (s.get().active==selected).to_string() tabindex=move || if s.get().active==focus {"0"}else{"-1"} title=f.path.clone() on:click=move |_| action("open-file",&id)>{f.path.clone()}</button><button class="close-tab" aria-label=format!("Close {}",f.path) title=format!("Close {}",f.path) on:click=move |_| action("close-tab",&close)>"×"</button></div>}
                                    }/>
                                    <div class="editor-tab-actions">
                                        <button class="icon-button" aria-label="Show source in PDF" title=move || format!("Show source in PDF. {}", s.get().source_map_status) disabled=move || !s.get().source_map_ready||s.get().source_map_busy on:click=move |_| action("source-to-pdf","")><Icon name="to-pdf"/></button>
                                        <review_workspace::ReviewToggle state=Signal::derive(move || s.get().review_workspace)/>
                                    </div>
                                </div><div id="code-editor" role="tabpanel" aria-label="Source editor" aria-labelledby=move || if s.get().active.is_empty(){None}else{Some(dom_id("tab",&s.get().active))}></div>
                            </section>
                            <review_workspace::Panel state=Signal::derive(move || s.get().review_workspace) comments=Signal::derive(move || s.get().comments)>
                                <comments::Comments state=Signal::derive(move || s.get().comments)/>
                                <reviews::Reviews state=Signal::derive(move || s.get().reviews)/>
                            </review_workspace::Panel>
                            <div id="pane-divider" class="pane-divider" role="separator" aria-label="Resize editor and preview" aria-orientation="vertical" tabindex="0"></div>
                            <section class="preview-pane" aria-label="PDF preview">
                                <div class="preview-toolbar"><span>"PDF PREVIEW"</span><Show when=move || s.get().stale><span class="stale-badge">"Out of date"</span></Show><div class="header-spacer"></div>
                                    <button class="icon-button" aria-label="Show PDF location in source" title=move || format!("Show PDF location in source. {}", s.get().source_map_status) disabled=move || !s.get().source_map_ready||s.get().source_map_busy on:click=move |_| action("pdf-to-source","")><Icon name="to-source"/></button>
                                    <button class="icon-button" disabled=move || s.get().pdf_pages==0 aria-label="Search PDF" title="Search PDF" on:click=move |_| action("pdf-find","")><Icon name="search"/></button>
                                    <button class="icon-button" disabled=move || s.get().pdf_pages==0 aria-label="Fit PDF width" title="Fit width" on:click=move |_| action("pdf-fit-width","")><Icon name="fit-width"/></button>
                                    <button class="icon-button" disabled=move || s.get().pdf_pages==0 aria-label="Fit PDF page" title="Fit page" on:click=move |_| action("pdf-fit-page","")><Icon name="fit-page"/></button>
                                    <button class="icon-button" disabled=move || s.get().pdf_pages==0||s.get().pdf_scale<=25 title="Zoom out" aria-label="Zoom out" on:click=move |_| action("zoom-out", "")><Icon name="minus"/></button><span id="zoom-label">{move || format!("{}%",s.get().pdf_scale)}</span><button class="icon-button" disabled=move || {s.get().pdf_pages==0||s.get().pdf_scale>=400} title="Zoom in" aria-label="Zoom in" on:click=move |_| action("zoom-in", "")><Icon name="plus"/></button><button class="icon-button" disabled=move || !s.get().has_pdf aria-label="Download PDF" title="Download PDF" on:click=move |_| action("download-pdf", "")><Icon name="download"/></button>
                                </div>
                                <Show when=move || {s.get().pdf_pages>0}><div class="pdf-navigation" role="group" aria-label="PDF page navigation">
                                    <button class="icon-button" aria-label="Previous PDF page" title="Previous page" disabled=move || s.get().pdf_page<=1 on:click=move |_| action("pdf-previous","")><Icon name="page-previous"/></button>
                                    <label>"Page "<input type="number" min="1" max=move || s.get().pdf_pages prop:value=move || if page_editing.get(){page_draft.get()}else{s.get().pdf_page.to_string()} aria-label="PDF page number" on:focus=move |e| {set_page_draft.set(event_target_value(&e));set_page_editing.set(true);} on:input=move |e| {set_page_draft.set(event_target_value(&e));set_page_editing.set(true);} on:blur=move |_| set_page_editing.set(false) on:change=move |e| {action("pdf-page",&event_target_value(&e));set_page_editing.set(false);} on:keydown=move |e| {if e.key()=="Enter" && !e.is_composing() && e.key_code()!=229 && !composing() {e.prevent_default();action("pdf-page",&event_target_value(&e));set_page_editing.set(false);}}/></label><span>{move || format!("of {}",s.get().pdf_pages)}</span>
                                    <button class="icon-button" aria-label="Next PDF page" title="Next page" disabled=move || {s.get().pdf_page>=s.get().pdf_pages} on:click=move |_| action("pdf-next","")><Icon name="page-next"/></button>
                                </div></Show>
                                <Show when=move || s.get().pdf_find_open><div class="pdf-search" role="search" aria-label="Search PDF text">
                                    <form on:submit=move |e| {e.prevent_default();if !composing(){action("pdf-find-next","");}}><input id="pdf-search-query" aria-label="Find in PDF" placeholder="Find in PDF…" maxlength="4096" prop:value=move || s.get().pdf_query on:input=move |e| action("pdf-query",&event_target_value(&e)) on:keydown=move |e| {if e.is_composing() || e.key_code()==229 || composing(){return;}if e.key()=="Escape" {e.prevent_default();action("pdf-find-close","");}else if e.key()=="Enter"&&e.shift_key(){e.prevent_default();action("pdf-find-previous","");}}/><button class="icon-button" type="button" aria-label="Previous PDF match" disabled=move || s.get().pdf_find_count==0 on:click=move |_| action("pdf-find-previous","")>"‹"</button><button class="icon-button" type="submit" aria-label="Next PDF match" disabled=move || s.get().pdf_find_count==0>"›"</button><button class="icon-button" type="button" aria-label="Close PDF search" on:click=move |_| action("pdf-find-close","")>"×"</button></form>
                                    <div class="pdf-search-options"><label><input type="checkbox" prop:checked=move || s.get().pdf_case on:change=move |_| action("pdf-case","")/>"Match case"</label><label><input type="checkbox" prop:checked=move || s.get().pdf_whole on:change=move |_| action("pdf-whole","")/>"Whole words"</label><span class="pdf-find-status" aria-live="polite">{move || s.get().pdf_find_status}</span></div>
                                </div></Show>
                                <Show when=move || !s.get().pdf_error.is_empty()><p class="pdf-error" role="alert">{move || s.get().pdf_error}</p></Show>
                                <div class="pdf-stage"><div id="pdf-viewer"><div class="preview-empty"><span class="paper-icon"><Icon/></span><Show when=move || s.get().busy fallback=|| view!{<h2>"Make your ideas tangible."</h2><p>"Compile your document to see it here."<br/>"Everything happens on your device."</p><span class="shortcut-hint">"Ctrl / ⌘ + Enter to compile"</span>}>
                                    <Show when=move || { s.get().download_total > 0.0 } fallback=move || view!{<h2>"Working on your PDF."</h2><p>{move || s.get().status}</p><button class="text-button show-live-log" aria-expanded=move || s.get().show_log.to_string() on:click=move |_| action("log", "")><Icon name="terminal"/>{move || if s.get().show_log {"Hide log"} else {"Show log"}}</button>}>
                                        <h2>"Getting LaTeX ready."</h2>
                                        <progress class="download-progress" aria-label="Compiler download" max=move || s.get().download_total value=move || s.get().download_loaded></progress>
                                        <p class="download-amount">{move || format!("{:.0} of {:.0} MB", s.get().download_loaded, s.get().download_total)}</p>
                                        <p>"Downloaded once and kept in this browser, so later compiles are quick and work offline."<br/>"Your document stays on this device."</p>
                                    </Show>
                                </Show></div></div></div>
                            </section>
                        </div>
                        <Show when=move || s.get().show_log || s.get().show_issues><section id="compilation-issues" class="diagnostics" aria-label="Compilation diagnostics"><div class="diagnostics-header"><span>{move || {let state=s.get();if state.busy || (state.show_log && state.build_issues.is_empty()) {"Compilation log"} else {"Compilation issues"}}}</span><button class="icon-button" aria-label="Close compilation issues" on:click=move |_| action("issues-close", "")>"×"</button></div><div class="diagnostic-content"><ul class="build-issues" aria-label="Compilation issues"><For each=move || s.get().build_issues.into_iter().enumerate() key=|(index,entry)|(*index,entry.code.clone(),entry.summary.clone(),entry.file.clone(),entry.line) children=move |(index,entry)|{
                            let location = entry.file.as_ref().map(|file| match entry.line {Some(line)=>format!("{file}:{line}"),None=>file.clone()}).unwrap_or_default();
                            let target = entry.file.as_ref().is_some_and(|path|s.get().files.iter().any(|file|&file.path==path && !file.binary));
                            let advice = (entry.severity == "error" && !entry.action.is_empty()).then(|| view!{<p class="issue-action">{entry.action}</p>});
                            view!{<li data-severity=entry.severity><strong>{entry.summary}</strong>{if target {view!{<a class="issue-source" href="#code-editor" on:click=move |event|{event.prevent_default();action("issue-source",&index.to_string());}>{location}</a>}.into_any()}else{view!{<span class="issue-source">{location}</span>}.into_any()}}{advice}</li>}
                        }/></ul><Show when=move || s.get().build_issues.iter().any(|entry|entry.severity=="warning")><p class="warning-advice">"Review the source and recompile."</p></Show><Show when=move || s.get().build_issues.is_empty() && !s.get().busy><p class="warning-advice">"No compilation issues."</p></Show><Show when=move || s.get().show_log><section role="region" aria-label="Raw compilation log" class="raw-log" aria-busy=move || s.get().busy.to_string()><div class="diagnostics-header"><span>"Raw compilation log"<Show when=move || s.get().busy><span class="live-badge">"Live"</span></Show></span><button class="icon-button" aria-label="Close log" on:click=move |_| action("log", "")>"×"</button></div>
                            // While compiling, web/compile-log.js appends batched output to this element directly.
                            <Show when=move || s.get().busy fallback=move || view!{<pre>{move || s.get().log}</pre>}><pre id="live-compile-log" class="live-log"></pre></Show></section></Show></div></section></Show>
                        <footer class="editor-status"><span role="status" aria-label="Compilation status" aria-live="polite"><button class="compilation-status-button" aria-controls="compilation-issues" aria-expanded=move || (s.get().show_issues||s.get().show_log).to_string() on:click=move |_| action("issues", "")>{move || s.get().status}</button></span><button aria-label=move || if s.get().show_log {"Hide compilation log"} else {"Show compilation log"} aria-expanded=move || s.get().show_log.to_string() on:click=move |_| action("log", "")><Icon name="terminal"/>"Log"</button><div class="header-spacer"></div><span class="local-tab-status" title="Changes synchronize between tabs in this browser profile.">{move || s.get().tab_sync_status}</span><Show when=move || s.get().plaintext_demo || s.get().direct_enabled || s.get().direct_active><span>{move || s.get().sync_status}</span></Show><span>"UTF-8"</span><span>"LaTeX"</span></footer>
                    </section>
                </div>
            }>
                <aside class="dashboard-sidebar">
                    <a href="#" class="brand" on:click=move |e| { e.prevent_default(); action("home", ""); }><span class="brand-mark">"s"</span>"scribyra"<span class="alpha-tag">"preview"</span></a>
                    <div class="workspace-label">"YOUR WORKSPACE"</div>
                    <button class="nav-item selected" on:click=move |_| action("filter", "")><Icon name="folder"/>"All projects"<span class="nav-count">{move || s.get().projects.len()}</span></button>
                    <button class="nav-item" on:click=move |_| action("diagnostics", "")><Icon name="pulse"/>"Diagnostics"</button>
                    <div class="sidebar-bottom dashboard-bottom"><div class="local-badge"><span class="tiny-dot"></span>"Local-first. Always yours."</div><p>"A little less friction."<br/>"A little more possibility."</p><button class="nav-item" on:click=move |_| action("storage", "")><Icon name="lock"/>"Storage & backups"</button><button class="nav-item" on:click=move |_| action("report", "")><Icon name="flag"/>"Report a problem"</button><div class="sidebar-foot"><span class="sidebar-links"><a href="https://scribyra.com/privacy.html" target="_blank" rel="noopener">"Privacy"</a>" · "<a href="https://scribyra.com/licenses.html" target="_blank" rel="noopener">"Licences"</a></span><button class="icon-button" title="Toggle theme" aria-label="Toggle theme" on:click=move |_| action("theme", "")><Icon name="sun"/></button></div></div>
                </aside>
                <main class="dashboard-main">
                    <header class="dashboard-topbar"><span>"Workspace"<span class="breadcrumb-slash">"/"</span><strong>"All projects"</strong></span><span class="device-label"><span class="tiny-dot"></span>"On this device"</span></header>
                    <div class="dashboard-content">
                        <div class="welcome-row"><div><div class="eyebrow">"ROOM TO THINK"</div><h1>"Your next great idea starts here."</h1><p>"A quiet space to write, explore, and bring your work to life."</p></div><button class="button primary" on:click=move |_| action("new", "")><Icon name="plus"/>"New project"</button></div>
                        <div class="start-banner"><div class="banner-art" aria-hidden="true"><span>"∑"</span><i>"f(x)"</i><b>"Aa"</b></div><div><span class="eyebrow">"FROM FIRST DRAFT TO FINAL PAPER"</span><h2>"Just you and your ideas."</h2><p>"Write LaTeX. See it take shape. Keep every word on your device."</p><button class="button secondary sample-button" on:click=move |_| action("starter", "")>"Start with a sample paper"<Icon name="arrow"/></button></div><span class="banner-corner" aria-hidden="true">"✳"</span></div>
                        <div class="projects-toolbar"><h2>"Your projects"</h2><p class="projects-hint" hidden=move || !s.get().projects.is_empty() || !s.get().filter.is_empty()>"Nothing here yet. Bring an existing paper as a ZIP, or start fresh."</p><label class="search-box" hidden=move || s.get().projects.is_empty() && s.get().filter.is_empty()><Icon name="search"/><input type="search" placeholder="Find a project…" aria-label="Find a project" prop:value=move || s.get().filter on:input=move |e| action("filter", &event_target_value(&e))/><kbd>"/"</kbd></label><button class="button secondary" on:click=move |_| action("import", "")><Icon name="upload"/>"Import ZIP"</button></div>
                        <div class="project-grid">
                            <For each=move || s.get().projects key=|p| p.id.clone() children=move |p| {
                                let id = p.id.clone(); let menu = id.clone();
                                view! { <article class="project-card"><button class="card-open" on:click=move |_| action("open", &id)><div class="document-thumbnail"><div class="mini-paper"><div class="mini-title"></div><div class="mini-author"></div><div class="mini-rule"></div><div class="mini-lines"></div><div class="mini-equation">"∫ f(x) dx"</div><div class="mini-lines short"></div></div><span class="document-type">"LaTeX"</span></div><div class="card-details"><h3>{p.name}</h3><p>{format!("{} {} · {}", p.files, if p.files == 1 { "file" } else { "files" }, p.date)}</p></div></button><button class="card-menu icon-button" aria-haspopup="menu" aria-expanded="false" data-project=p.id.clone() title="Project actions" aria-label="Project actions" on:click=move |_| action("project-menu", &menu)><Icon name="more"/></button></article> }
                            }/>
                            <button class="new-project-card" on:click=move |_| action("new", "")><span><Icon name="plus"/></span><strong>"A fresh page"</strong><p>"Make room for something new."</p></button>
                        </div>
                        <footer class="dashboard-footer"><Icon name="lock"/><span>"No account needed. Compile on your device. Your workspace, your rules."</span></footer>
                    </div>
                </main>
            </Show>
            <Show when=move || !s.get().notice.is_empty()><div class="toast" role="status" aria-label="Workspace notification"><span>{move || s.get().notice}</span><button aria-label="Dismiss notification" on:click=move |_| action("dismiss", "")>"×"</button></div></Show>
        </div>
    }
}
#[wasm_bindgen]
pub fn main() {
    console_error_panic_hook::set_once();
    mount_to_body(App);
}

/// Content-free, bounded local diagnostics shared with native callers.
#[wasm_bindgen]
pub fn telemetry_consent_record(input: &str, performance: bool, errors: bool, usage: bool) -> Option<String> {
    scribyra_core::telemetry::consent_record(input, performance, errors, usage)
}

#[wasm_bindgen]
pub fn telemetry_faro_batch(input: &str, now_unix_ms: f64, usage: bool, session_id: &str) -> Option<String> {
    scribyra_core::telemetry::transport::faro::batch(
        input.as_bytes(), now_unix_ms as u64, usage, session_id,
        |ms| js_sys::Date::new(&JsValue::from_f64(ms)).to_iso_string().as_string(),
    ).ok()
}

#[wasm_bindgen]
pub struct TelemetryRecorder(scribyra_core::telemetry::Recorder);

#[wasm_bindgen]
impl TelemetryRecorder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self { Self(scribyra_core::telemetry::Recorder::default()) }
    pub fn configure(&mut self, collect: bool, allow_export: bool) {
        self.0.configure(scribyra_core::telemetry::Settings { collect, allow_export });
    }
    pub fn record(&mut self, input: &str) -> bool { self.0.record(input) }
    pub fn set_identity(&mut self, input: &str) -> Result<(), JsValue> {
        self.0.set_identity(input).map_err(JsValue::from_str)
    }
    pub fn snapshot(&self) -> String { self.0.snapshot() }
    pub fn clear(&mut self) { self.0.clear(); }
    pub fn export(&self) -> Result<String, JsValue> {
        self.0.export().map_err(JsValue::from_str)
    }
}

#[wasm_bindgen]
pub fn tree_command(input: &str) -> Result<String, JsValue> {
    let request = serde_json::from_str(input).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let nodes = scribyra_core::tree::execute(request).map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&nodes).map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn valid_project_path(path: &str) -> bool {
    scribyra_core::valid_path(path)
}

#[wasm_bindgen]
pub fn blob_hash(bytes: &[u8]) -> String {
    scribyra_core::blob::hash(bytes)
}
#[wasm_bindgen]
pub fn valid_blob_hash(hash: &str) -> bool {
    scribyra_core::blob::valid_hash(hash)
}

#[wasm_bindgen]
pub fn reference_plan(input: &str) -> Result<String, JsValue> {
    let request = serde_json::from_str(input).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_json::to_string(&scribyra_core::references::plan(request))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn relative_project_path(from: &str, to: &str) -> Result<String, JsValue> {
    scribyra_core::references::relative(from, to).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn workspace_search(input: &str) -> Result<String, JsValue> {
    let request = serde_json::from_str(input).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let result = scribyra_core::editor::search(request).map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}
#[wasm_bindgen]
pub fn source_outline(input: &str) -> Result<String, JsValue> {
    let files = serde_json::from_str(input).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let result = scribyra_core::editor::outline(files).map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[component]
fn SearchPanel(s: ReadSignal<State>) -> impl IntoView {
    view! { <section class="tool-panel" aria-label="Project search">
        <form on:submit=move |e| {e.prevent_default();if !composing(){action("search-run","");}}>
            <label>"Find"<input id="project-search-query" aria-label="Search text" prop:value=move || s.get().search_query on:input=move |e| action("search-query",&event_target_value(&e))/></label>
            <label>"Replace with"<input aria-label="Replacement text" prop:value=move || s.get().search_replacement on:input=move |e| action("search-replacement",&event_target_value(&e))/></label>
            <label>"Scope"<select aria-label="Search scope" prop:value=move || s.get().search_scope on:change=move |e| action("search-scope",&event_target_value(&e))><option value="project">"Entire project"</option><option value="file">"Current file"</option></select></label>
            <div class="search-options">
                <label><input type="checkbox" prop:checked=move || s.get().search_case on:change=move |_| action("search-case","")/>"Match case"</label>
                <label><input type="checkbox" prop:checked=move || s.get().search_whole on:change=move |_| action("search-whole","")/>"Whole words"</label>
                <label><input type="checkbox" prop:checked=move || s.get().search_regex on:change=move |_| action("search-regex","")/>"Regular expression"</label>
            </div>
            <button class="button primary" type="submit">{move || if s.get().search_busy {"Cancel search"} else {"Run search"}}</button>
        </form>
        <p class="tool-status" aria-live="polite">{move || s.get().search_status}</p>
        <button class="button secondary" disabled=move || {let state=s.get();state.search_busy||state.search_stale||state.search_truncated||state.search_results.is_empty()} on:click=move |_| action("search-replace","")>"Review replacements"</button>
        <Show when=move || !s.get().undo_replace_label.is_empty()><button class="button secondary" on:click=move |_| action("search-undo","")>{move || s.get().undo_replace_label}</button></Show>
        <div class="tool-results" aria-label="Search results"><For each=move || s.get().search_results key=|hit| (hit.index,hit.path.clone(),hit.line,hit.column,hit.preview.clone()) children=move |hit| view!{
            <button disabled=move || s.get().search_busy||s.get().search_stale on:click=move |_| action("search-hit",&hit.index.to_string())><strong>{format!("{}:{}:{}",hit.path,hit.line,hit.column)}</strong><span>{hit.preview}</span></button>
        }/></div>
        <p class="tool-help">"Regular expressions use Rust syntax. Use $1 or ${name} for captured replacements. Results are limited to 2,000 matches and 1 MiB of replacement text."</p>
    </section> }
}
#[component]
fn OutlinePanel(s: ReadSignal<State>) -> impl IntoView {
    view! { <section class="tool-panel" aria-label="Source outline">
        <label>"Outline scope"<select aria-label="Outline scope" prop:value=move || s.get().outline_scope on:change=move |e| action("outline-scope",&event_target_value(&e))><option value="file">"Current file"</option><option value="project">"Entire project"</option></select></label>
        <p class="tool-status" aria-live="polite">{move || s.get().outline_status}</p>
        <div class="tool-results"><For each=move || s.get().outline_items key=|item| (item.index,item.title.clone(),item.path.clone(),item.line) children=move |item| view!{
            <button disabled=move || s.get().outline_busy style=format!("padding-left:{}px",8+item.level.min(5)*8) on:click=move |_| action("outline-hit",&item.index.to_string())><strong>{item.title}</strong><span>{format!("{}:{}",item.path,item.line)}</span></button>
        }/></div>
        <p class="tool-help">"Literal TeX headings. Custom macros and included-file order are not expanded."</p>
    </section> }
}

#[wasm_bindgen]
pub fn source_map_query(data: &[u8], manifest: &str, query: &str) -> Result<String, JsValue> {
    #[derive(Deserialize)]
    #[serde(tag = "op", rename_all = "camelCase")]
    enum Query {
        Inspect,
        Forward {
            id: String,
            line: u32,
            #[serde(rename = "pageHint")]
            page_hint: Option<u32>,
        },
        Inverse {
            page: u32,
            x: f32,
            y: f32,
            height: f32,
        },
    }
    let manifest = serde_json::from_str(manifest).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let query: Query =
        serde_json::from_str(query).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let document =
        scribyra_core::synctex::Document::new(data, manifest).map_err(|e| JsValue::from_str(&e))?;
    match query {
        Query::Inspect => Ok("{}".into()),
        Query::Forward {
            id,
            line,
            page_hint,
        } => serde_json::to_string(
            &document
                .forward(&id, line, page_hint)
                .map_err(|e| JsValue::from_str(&e))?,
        )
        .map_err(|e| JsValue::from_str(&e.to_string())),
        Query::Inverse { page, x, y, height } => serde_json::to_string(
            &document
                .inverse(page, x, y, height)
                .map_err(|e| JsValue::from_str(&e))?,
        )
        .map_err(|e| JsValue::from_str(&e.to_string())),
    }
}

#[wasm_bindgen]
pub fn validate_project_command(request: &str, context: &str) -> Result<String, JsValue> {
    use scribyra_core::commands::{self, Error};
    let work = || -> Result<String, Error> {
        if request.len() > 129 * 1024 * 1024 || context.len() > 4096 {
            return Err(Error::invalid("Command envelope exceeds the size limit."));
        }
        let request: commands::Request =
            serde_json::from_str(request).map_err(|e| Error::invalid(e.to_string()))?;
        let context = serde_json::from_str(context).map_err(|e| Error::invalid(e.to_string()))?;
        commands::validate(&request, &context)?;
        serde_json::to_string(&request).map_err(|e| Error::invalid(e.to_string()))
    };
    work().map_err(|e| JsValue::from_str(&serde_json::to_string(&e).unwrap()))
}

#[wasm_bindgen]
pub fn validate_source_patch(edits: &str, sources: &str, bytes: usize) -> Result<String, JsValue> {
    use scribyra_core::commands::{self, Error};
    let work = || -> Result<String, Error> {
        let edits = serde_json::from_str::<Vec<commands::Edit>>(edits)
            .map_err(|e| Error::invalid(e.to_string()))?;
        let sources = serde_json::from_str(sources).map_err(|e| Error::invalid(e.to_string()))?;
        serde_json::to_string(&commands::validate_patch(&edits, &sources, bytes)?)
            .map_err(|e| Error::invalid(e.to_string()))
    };
    work().map_err(|e| JsValue::from_str(&serde_json::to_string(&e).unwrap()))
}

/// Shared Rust package rules, also usable by a native companion.
#[wasm_bindgen]
pub fn compilation_diagnostics(json: &str) -> Result<String, JsValue> {
    let work = || -> Result<String, String> {
        if json.len() > 20 * 1024 * 1024 {
            return Err("Compiler evidence is too large".into());
        }
        let request = serde_json::from_str(json).map_err(|e| e.to_string())?;
        serde_json::to_string(&scribyra_core::diagnostics::diagnose(request)?)
            .map_err(|e| e.to_string())
    };
    work().map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub fn validate_dependency_manifest(json: &str, snapshot: &str) -> Result<(), JsValue> {
    scribyra_core::dependencies::Manifest::parse(json, snapshot)
        .map(|_| ())
        .map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub fn dependency_closure(json: &str, snapshot: &str, roots: &str) -> Result<String, JsValue> {
    let work = || -> Result<String, String> {
        if roots.len() > 16 * 1024 {
            return Err("Dependency roots exceed their bound".into());
        }
        let roots: Vec<String> = serde_json::from_str(roots).map_err(|e| e.to_string())?;
        let graph = scribyra_core::dependencies::Manifest::parse(json, snapshot)?;
        serde_json::to_string(&graph.closure(&roots)?).map_err(|e| e.to_string())
    };
    work().map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub fn validate_cache_settings(json: &str) -> Result<String, JsValue> {
    let work = || -> Result<String, String> {
        if json.len() > 4096 {
            return Err("Cache settings are too large".into());
        }
        let settings: scribyra_core::cache::Limits =
            serde_json::from_str(json).map_err(|e| e.to_string())?;
        settings.validate()?;
        serde_json::to_string(&settings).map_err(|e| e.to_string())
    };
    work().map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub fn cache_evictions(json: &str) -> Result<String, JsValue> {
    let work = || -> Result<String, String> {
        if json.len() > 4 * 1024 * 1024 {
            return Err("Cache plan is too large".into());
        }
        let input = serde_json::from_str(json).map_err(|e| e.to_string())?;
        serde_json::to_string(&scribyra_core::cache::eviction(input)?).map_err(|e| e.to_string())
    };
    work().map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub struct TexCatalog(scribyra_core::packages::Catalog);
#[wasm_bindgen]
impl TexCatalog {
    pub fn encode_portable_environment(
        &self,
        lock: &str,
        runtime: &str,
        archives: js_sys::Array,
        metadata: js_sys::Array,
    ) -> Result<Vec<u8>, JsValue> {
        let work = || -> Result<Vec<u8>, String> {
            use scribyra_core::{environment, portable};
            let lock = environment::Lock::parse(lock)?;
            let runtime = serde_json::from_str(runtime).map_err(|e| e.to_string())?;
            self.0.check_environment(&lock, &runtime)?;
            if archives.length() as usize != lock.packages.len() || metadata.length() > 65 {
                return Err("Invalid package bundle entry counts".into());
            }
            let mut archive_bytes = Vec::new();
            let mut size = 0usize;
            for value in archives.iter() {
                let value = value
                    .dyn_into::<js_sys::Uint8Array>()
                    .map_err(|_| "Package archives must be byte arrays")?;
                size = size.saturating_add(value.length() as usize);
                if size > environment::MAX_PACKAGE_BYTES {
                    return Err("Package archives exceed 96 MiB".into());
                }
                archive_bytes.push(value.to_vec());
            }
            let mut assets = Vec::new();
            let mut size = 0usize;
            for value in metadata.iter() {
                let value = value
                    .dyn_into::<js_sys::Array>()
                    .map_err(|_| "Metadata entries must be arrays")?;
                if value.length() != 2 {
                    return Err("Invalid metadata entry".into());
                }
                let path = value.get(0).as_string().ok_or("Invalid metadata path")?;
                let bytes = value
                    .get(1)
                    .dyn_into::<js_sys::Uint8Array>()
                    .map_err(|_| "Metadata must be byte arrays")?;
                size = size.saturating_add(bytes.length() as usize);
                if path.len() > 128
                    || bytes.length() > 2 * 1024 * 1024
                    || size > portable::MAX_METADATA
                {
                    return Err("Package metadata exceeds its limit".into());
                }
                assets.push(portable::Asset {
                    path,
                    bytes: bytes.to_vec(),
                });
            }
            portable::encode(&lock, &runtime, &archive_bytes, &assets)
        };
        work().map_err(|e| JsValue::from_str(&e))
    }
    pub fn decode_portable_environment(
        bytes: &[u8],
        runtime: &str,
    ) -> Result<js_sys::Array, JsValue> {
        let work = || -> Result<js_sys::Array, String> {
            let runtime = serde_json::from_str(runtime).map_err(|e| e.to_string())?;
            let decoded = scribyra_core::portable::decode(bytes, &runtime)?;
            let result = js_sys::Array::new();
            let metadata: Vec<_> = decoded
                .metadata
                .iter()
                .map(scribyra_core::portable::asset_info)
                .collect();
            result.push(&JsValue::from_str(&serde_json::json!({"lock":decoded.lock,"packages":decoded.packages,"metadata":metadata}).to_string()));
            for asset in decoded.metadata {
                result.push(&js_sys::Uint8Array::from(asset.bytes.as_slice()));
            }
            for bytes in decoded.archives {
                result.push(&js_sys::Uint8Array::from(bytes.as_slice()));
            }
            Ok(result)
        };
        work().map_err(|e| JsValue::from_str(&e))
    }
    pub fn validate_compatibility(json: &str, runtime: &str, binary: &str) -> Result<(), JsValue> {
        let work = || -> Result<(), String> {
            if runtime.len() > 8192 || binary.len() > 8192 {
                return Err("Compiler compatibility input exceeds its bound".into());
            }
            let runtime = serde_json::from_str(runtime).map_err(|e| e.to_string())?;
            let binary: Option<scribyra_core::compatibility::File> =
                serde_json::from_str(binary).map_err(|e| e.to_string())?;
            scribyra_core::compatibility::Manifest::parse(json)?.check(&runtime, binary.as_ref())
        };
        work().map_err(|e| JsValue::from_str(&e))
    }
    pub fn metadata_bucket(value: &str) -> String {
        scribyra_core::packages::metadata_bucket(value)
    }
    pub fn lookup_plan(requests: &str, log: &str) -> Result<String, JsValue> {
        let work = || -> Result<String, String> {
            if requests.len() > 1024 * 1024 {
                return Err("TeX lookup input exceeds its limit".into());
            }
            let requests = serde_json::from_str::<Vec<scribyra_core::packages::Lookup>>(requests)
                .map_err(|e| e.to_string())?;
            serde_json::to_string(&scribyra_core::packages::metadata_plan(&requests, log)?)
                .map_err(|e| e.to_string())
        };
        work().map_err(|e| JsValue::from_str(&e))
    }
    pub fn merge(&mut self, json: &str) -> Result<(), JsValue> {
        self.0.merge(json).map_err(|e| JsValue::from_str(&e))
    }
    pub fn add_fonts(&mut self, json: &str) -> Result<(), JsValue> {
        self.0.add_fonts(json).map_err(|e| JsValue::from_str(&e))
    }
    pub fn add_languages(&mut self, json: &str) -> Result<(), JsValue> {
        self.0
            .add_languages(json)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn package_info(&self, names: &str) -> Result<String, JsValue> {
        let work = || -> Result<String, String> {
            let names: Vec<String> = serde_json::from_str(names).map_err(|e| e.to_string())?;
            serde_json::to_string(&self.0.package_info(&names)?).map_err(|e| e.to_string())
        };
        work().map_err(|e| JsValue::from_str(&e))
    }
    pub fn environment_manifest(bytes: &[u8]) -> Result<String, JsValue> {
        let work = || -> Result<String, String> {
            serde_json::to_string(&scribyra_core::environment::Lock::from_bundle(bytes)?)
                .map_err(|e| e.to_string())
        };
        work().map_err(|e| JsValue::from_str(&e))
    }
    pub fn environment_packages(lock: &str, runtime: &str) -> Result<String, JsValue> {
        let work = || -> Result<String, String> {
            let lock = scribyra_core::environment::Lock::parse(lock)?;
            let runtime: scribyra_core::environment::Runtime =
                serde_json::from_str(runtime).map_err(|e| e.to_string())?;
            runtime.validate()?;
            if lock.runtime != runtime {
                return Err("This project is locked to a different compiler, adapter or catalog. Use the matching build or explicitly unlock the environment.".into());
            }
            serde_json::to_string(&lock.packages.keys().collect::<Vec<_>>())
                .map_err(|e| e.to_string())
        };
        work().map_err(|e| JsValue::from_str(&e))
    }
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> Result<TexCatalog, JsValue> {
        scribyra_core::packages::Catalog::new(json)
            .map(TexCatalog)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn resolve(&self, requests: &str, log: &str) -> Result<String, JsValue> {
        let requests: Vec<scribyra_core::packages::Lookup> =
            serde_json::from_str(requests).map_err(|e| JsValue::from_str(&e.to_string()))?;
        serde_json::to_string(&self.0.resolve_failure(&requests, log))
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
    pub fn environment(&self, runtime: &str, names: &str) -> Result<String, JsValue> {
        let work = || -> Result<String, String> {
            let runtime = serde_json::from_str(runtime).map_err(|e| e.to_string())?;
            let names: Vec<String> = serde_json::from_str(names).map_err(|e| e.to_string())?;
            serde_json::to_string(&self.0.environment(runtime, &names)?).map_err(|e| e.to_string())
        };
        work().map_err(|e| JsValue::from_str(&e))
    }
    pub fn check_environment(&self, lock: &str, runtime: &str) -> Result<String, JsValue> {
        let work = || -> Result<String, String> {
            let lock = scribyra_core::environment::Lock::parse(lock)?;
            let runtime = serde_json::from_str(runtime).map_err(|e| e.to_string())?;
            self.0.check_environment(&lock, &runtime)?;
            serde_json::to_string(&lock).map_err(|e| e.to_string())
        };
        work().map_err(|e| JsValue::from_str(&e))
    }
    pub fn encode_environment(
        &self,
        lock: &str,
        runtime: &str,
        archives: js_sys::Array,
    ) -> Result<Vec<u8>, JsValue> {
        let work = || -> Result<Vec<u8>, String> {
            let lock = scribyra_core::environment::Lock::parse(lock)?;
            let runtime = serde_json::from_str(runtime).map_err(|e| e.to_string())?;
            if archives.length() as usize != lock.packages.len() {
                return Err("Package bundle archive count differs from lock.".into());
            }
            let mut size = 0usize;
            let mut bytes = Vec::new();
            for archive in archives.iter() {
                let array = archive
                    .dyn_into::<js_sys::Uint8Array>()
                    .map_err(|_| "Package bundle archives must be byte arrays.".to_string())?;
                size = size.saturating_add(array.length() as usize);
                if size > scribyra_core::environment::MAX_PACKAGE_BYTES {
                    return Err("Package bundle exceeds 96 MiB.".into());
                }
                bytes.push(array.to_vec());
            }
            self.0.encode_environment(&lock, &runtime, &bytes)
        };
        work().map_err(|e| JsValue::from_str(&e))
    }
    pub fn decode_environment(
        &self,
        bytes: &[u8],
        runtime: &str,
    ) -> Result<js_sys::Array, JsValue> {
        let runtime =
            serde_json::from_str(runtime).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let (lock, archives) = self
            .0
            .decode_environment(bytes, &runtime)
            .map_err(|e| JsValue::from_str(&e))?;
        let result = js_sys::Array::new();
        result.push(&JsValue::from_str(&serde_json::to_string(&lock).unwrap()));
        for archive in archives {
            result.push(&js_sys::Uint8Array::from(archive.as_slice()));
        }
        Ok(result)
    }
    pub fn unpack(&self, name: &str, bytes: &[u8]) -> Result<js_sys::Array, JsValue> {
        let files = self
            .0
            .unpack(name, bytes)
            .map_err(|e| JsValue::from_str(&e))?;
        let result = js_sys::Array::new();
        for (path, content) in files {
            let file = js_sys::Array::new();
            file.push(&JsValue::from_str(&path));
            file.push(&js_sys::Uint8Array::from(content.as_slice()));
            result.push(&file);
        }
        Ok(result)
    }
}

/// Host side of the discontinued Rust companion, kept for its test-only switch.
#[wasm_bindgen]
pub fn receive_companion_request(json: &str, context: &str) -> Result<String, JsValue> {
    scribyra_core::companion::receive(json, context)
        .and_then(|request| {
            serde_json::to_string(&request)
                .map_err(|e| scribyra_core::commands::Error::invalid(e.to_string()))
        })
        .map_err(|error| JsValue::from_str(&serde_json::to_string(&error).unwrap()))
}
#[wasm_bindgen]
pub fn validate_exchange(envelope: &str, grant: &str) -> Result<String, JsValue> {
    let work = || -> Result<String, String> {
        if envelope.len() > 129 * 1024 * 1024 || grant.len() > 8192 {
            return Err("Exchange envelope exceeds its limit.".into());
        }
        let packet = serde_json::from_str::<scribyra_core::exchange::Envelope>(envelope)
            .map_err(|e| e.to_string())?;
        let grant = serde_json::from_str(grant).map_err(|e| e.to_string())?;
        scribyra_core::exchange::validate(&packet, &grant).map_err(|e| e.message)?;
        serde_json::to_string(&packet).map_err(|e| e.to_string())
    };
    work().map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn validate_provider_request(input: &str, permissions: &str) -> Result<String, JsValue> {
    scribyra_core::providers::parse(input, permissions)
        .and_then(|request| {
            serde_json::to_string(&request)
                .map_err(|e| scribyra_core::commands::Error::invalid(e.to_string()))
        })
        .map_err(|error| JsValue::from_str(&serde_json::to_string(&error).unwrap()))
}

#[wasm_bindgen]
pub fn plan_folder_reconciliation(input: &str) -> Result<String, JsValue> {
    scribyra_core::reconciliation::parse_plan(input)
        .and_then(|plan| serde_json::to_string(&plan).map_err(|e| e.to_string()))
        .map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn private_folder_state_path(path: &str) -> bool {
    scribyra_core::reconciliation::private_state_path(path)
}

#[wasm_bindgen]
pub fn verify_folder_review(review: &str, current: &str) -> Result<String, JsValue> {
    let work = || -> Result<String, String> {
        use scribyra_core::reconciliation::{MAX_BYTES, Plan, parse_request, verify_review};
        if review.len() > 4 * MAX_BYTES + 2 * 1024 * 1024 {
            return Err("Reviewed folder plan exceeds its bound.".into());
        }
        let review: Plan = serde_json::from_str(review).map_err(|e| e.to_string())?;
        let current = parse_request(current)?;
        let result = verify_review(&review, &current)?;
        serde_json::to_string(&result).map_err(|e| e.to_string())
    };
    work().map_err(|e| JsValue::from_str(&e))
}
