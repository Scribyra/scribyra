use crate::comments;
use leptos::prelude::*;

#[derive(Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    pub mode: String,
    pub open: bool,
    pub count: usize,
    total: usize,
    pub preview: bool,
    tab: String,
    active: String,
    status_quiet: bool,
    filter: String,
    status: String,
    preview_url: String,
    preview_label: String,
    cards: Vec<Card>,
    files: Vec<File>,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Card {
    id: String,
    kind: String,
    group: String,
    author: String,
    initials: String,
    agent: bool,
    time: String,
    time_title: String,
    time_iso: String,
    quote: String,
    before: String,
    after: String,
    status: String,
    message_id: String,
    discussion_ids: Vec<String>,
    resolved: bool,
    outcome: String,
    detached: bool,
    conflicted: bool,
    colour: String,
    messages: Vec<Message>,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Message {
    id: String,
    author: String,
    initials: String,
    agent: bool,
    colour: String,
    time: String,
    time_title: String,
    time_iso: String,
    conflicted: bool,
    pending: bool,
    variants: Vec<Variant>,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(default)]
struct Variant {
    id: String,
    body: String,
    redacted: bool,
}
#[derive(Clone, Default, PartialEq, serde::Deserialize)]
#[serde(default)]
struct File {
    id: String,
    path: String,
    count: usize,
}
#[component]
pub fn Mode(state: Signal<State>) -> impl IntoView {
    let mode = move || state.get().mode;
    view! {
        <label class="review-mode" data-mode=mode title=move || match state.get().mode.as_str() {
            "reviewing" => "Reviewing: your edits become suggestions",
            "viewing" => "Viewing: read only",
            _ => "Editing: changes apply directly",
        }>
            {move || match state.get().mode.as_str() {
                "reviewing" => view! { <crate::Icon name="track"/> }.into_any(),
                "viewing" => view! { <crate::Icon name="eye"/> }.into_any(),
                _ => view! { <crate::Icon name="pencil"/> }.into_any(),
            }}
            <select aria-label="Editor mode" title="Choose how you work: Editing, Reviewing or Viewing" prop:value=mode on:change=move |e| crate::action("review-mode", &event_target_value(&e))>
                <option value="editing" data-icon="pencil" data-hint="Changes apply directly">"Editing"</option><option value="reviewing" data-icon="track" data-hint="Your edits are saved as suggestions">"Reviewing"</option><option value="viewing" data-icon="eye" data-hint="Read only">"Viewing"</option>
            </select>
            <crate::Icon name="chevron"/>
        </label>
        <span class="review-mode-hint">{move || match state.get().mode.as_str() {
            "reviewing" => "Your edits are saved as suggestions",
            "viewing" => "Read only",
            _ => "Changes apply directly",
        }}</span>
        <span class="review-mode-tip" title="Select text, then choose Add comment or press Ctrl+Alt+M (⌘⌥M on Mac)">"Select text to comment"</span>
    }
}
#[component]
pub fn ReviewToggle(state: Signal<State>) -> impl IntoView {
    view! {
        <button id="review-toggle" class="review-toggle" aria-label="Review" title=move || format!("Review: {} open", state.get().count) aria-controls="review-workspace" aria-expanded=move || state.get().open.to_string() on:click=move |_| crate::action("review-toggle", "")>
            <crate::Icon name="comment"/><span class="review-toggle-label">"Review"</span>
            <Show when=move || { state.get().count > 0 }><span class="review-count">{move || state.get().count}</span></Show>
        </button>
    }
}
fn icon(name: &'static str) -> impl IntoView {
    let d = match name {
        "check" => "M3.5 8.5 6.5 11.5 12.5 4.5",
        "close" => "M4 4l8 8M12 4l-8 8",
        "more" => "M3.5 8h.01M8 8h.01M12.5 8h.01",
        "back" => "M9.5 3.5 5 8l4.5 4.5",
        "resolve" => "M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0ZM5.5 8.2 7.3 10l3.2-3.8",
        "reopen" => "M3 8a5 5 0 1 0 1.6-3.7L3 5.8M3 2.8v3h3",
        _ => "",
    };
    view! { <svg class=format!("review-icon review-icon-{name}") viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d=d/></svg> }
}
/// Disclosure popup. web/review-workspace.js owns open and close, so the
/// state survives card updates and needs no reactive signal per card.
fn menu(label: &'static str, items: AnyView) -> impl IntoView {
    view! {
        <div class="review-menu">
            <button type="button" class="review-icon-button review-menu-toggle" aria-label=label title=label aria-expanded="false">{icon("more")}</button>
            <div class="review-menu-items" hidden=true>{items}</div>
        </div>
    }
}
fn stamp(time: String, title: String, iso: String) -> impl IntoView {
    view! { <time datetime=iso title=title>{time}</time> }
}
fn shown(text: String) -> AnyView {
    if text.trim().is_empty() {
        let label = if text.contains('\n') { "line break" } else { "space" };
        view! { <em class="review-whitespace">{label}</em> }.into_any()
    } else {
        view! { <span>{text.trim().to_string()}</span> }.into_any()
    }
}
fn body(message: &Message) -> AnyView {
    message.variants.iter().map(|variant| {
        let class = if variant.redacted { "review-message-body redacted" } else { "review-message-body" };
        let text = if variant.redacted { "Message deleted".to_string() } else { variant.body.clone() };
        view! { <p class=class>{text}</p> }
    }).collect_view().into_any()
}
fn message_menu(message: &Message, extra: Option<AnyView>) -> AnyView {
    let (edit, delete) = (message.id.clone(), message.id.clone());
    let live = message.variants.iter().any(|variant| !variant.redacted);
    let items = view! {
        {extra}
        {live.then(|| view! {
            <button type="button" on:click=move |_| crate::action("comment-edit", &edit)>"Edit"</button>
            <button type="button" class="danger" on:click=move |_| crate::action("comment-redact", &delete)>"Delete"</button>
        })}
    }.into_any();
    menu("Comment actions", items).into_any()
}
fn suggestion_body(card: Memo<Card>, id: String, viewing: Memo<bool>) -> AnyView {
    let (accept, reject, jump) = (id.clone(), id.clone(), id);
    let (expanded, set_expanded) = signal(false);
    let long = move || card.with(|c| c.before.chars().count() + c.after.chars().count() > 120 || c.before.lines().count() + c.after.lines().count() > 3);
    let verb = move || card.with(|c| if c.before.is_empty() { "Added" } else if c.after.is_empty() { "Deleted" } else { "Changed" });
    view! {
        <button type="button" class="review-card-location" title="Show in source" on:click=move |_| crate::action("review-card", &jump)>
            <span class="review-change" class:clamped=move || long() && !expanded.get()>
                <span class="review-change-verb">{verb}</span>" "
                <Show when=move || card.with(|c| !c.before.is_empty())><del>{move || shown(card.with(|c| c.before.clone()))}</del></Show>
                <Show when=move || card.with(|c| !c.before.is_empty() && !c.after.is_empty())><span class="review-change-verb">" to "</span></Show>
                <Show when=move || card.with(|c| !c.after.is_empty())><ins>{move || shown(card.with(|c| c.after.clone()))}</ins></Show>
            </span>
        </button>
        <Show when=long><button type="button" class="review-expand" aria-expanded=move || expanded.get().to_string() on:click=move |_| set_expanded.update(|v| *v = !*v)>{move || if expanded.get() { "Show less" } else { "Show more" }}</button></Show>
        <Show when=move || card.with(|c| c.status == "incomplete")><p class="review-card-note">"Discussion grouping is incomplete. The original proposal and replies are retained."</p></Show>
        <Show when=move || card.with(|c| c.status == "conflicted")><p class="review-card-note">"The source changed under this suggestion, so it can no longer be accepted."</p></Show>
        <Show when=move || card.with(|c| c.resolved)><p class="review-card-note">{move || card.with(|c| c.outcome.clone())}</p></Show>
        <div class="review-card-actions" hidden=move || viewing.get() || card.with(|c| c.resolved)>
            <button type="button" class="review-accept" disabled=move || card.with(|c| c.status != "pending") on:click=move |_| crate::action("suggestion.accept", &accept)>{icon("check")}"Accept"</button>
            <button type="button" class="review-reject" on:click=move |_| crate::action("suggestion.reject", &reject)>{icon("close")}"Reject"</button>
        </div>
    }.into_any()
}
fn composing_in(card: &Card, composer: &comments::Composing) -> bool {
    let target = if composer.mode == "suggestion" { &composer.suggestion_id } else { &composer.thread_id };
    composer.inline && composer.mode != "create" && card.discussion_ids.contains(target)
}
fn discussion_body(card: Memo<Card>, id: String, composer: Memo<comments::Composing>, active: Memo<String>, comments_state: Signal<comments::State>, suggestion: bool) -> AnyView {
    let (jump, reply, is_active) = (id.clone(), id.clone(), id);
    let first = move || card.with(|c| c.messages.first().cloned().unwrap_or_default());
    let replies = move || card.with(|c| c.messages.iter().skip(if suggestion { 0 } else { 1 }).cloned().collect::<Vec<_>>());
    let count = move || card.with(|c| c.messages.len().saturating_sub(if suggestion { 0 } else { 1 }));
    let composing_here = move || composer.with(|composer| card.with(|card| composing_in(card, composer)));
    view! {
        {(!suggestion).then(|| view! {
            <button type="button" class="review-card-location review-quote" title="Show in source" on:click=move |_| crate::action("review-card", &jump)>
                <span class="sr-only">"Comment on: "</span>{move || card.with(|c| if c.quote.trim().is_empty() { "This position".to_string() } else { c.quote.clone() })}
            </button>
            <div class="review-message-first">{move || body(&first())}</div>
        })}
        <Show when=move || card.with(|c| c.messages.iter().any(|m| m.conflicted))><p class="review-card-note">"Edited concurrently. All versions are shown."</p></Show>
        <Show when=move || { count() > 0 }>
            <p class="review-reply-count">{move || { let n = count(); if n == 1 { "1 reply".to_string() } else { format!("{n} replies") } }}</p>
            <ol class="review-replies" aria-label="Replies">
                <For each=replies key=|m| serde_json::to_string(m).unwrap_or_default() children=move |message| {
                    let controls = message_menu(&message, None);
                    let rendered = body(&message);
                    view! { <li class="review-reply" style=format!("--message-author:{}", message.colour)>
                        <div class="review-card-head">
                            <span class="review-avatar small" class:agent=message.agent aria-hidden="true">{message.initials.clone()}</span>
                            <span class="review-who"><span class="review-author">{message.author.clone()}</span>{stamp(message.time.clone(), message.time_title.clone(), message.time_iso.clone())}</span>
                            <div class="review-card-tools">{controls}</div>
                        </div>
                        {rendered}
                    </li> }
                }/>
            </ol>
        </Show>
        <Show when=move || composing_here()
            fallback=move || { let (reply, is_active) = (reply.clone(), is_active.clone()); view! {
                <Show when={ let is_active = is_active.clone(); move || active.with(|a| *a == is_active) }>
                    { let reply = reply.clone(); view! { <button type="button" class="review-reply-start" on:click=move |_| crate::action(if suggestion { "comment-suggestion-reply" } else { "comment-reply" }, &reply)>"Reply"<span aria-hidden="true">"…"</span></button> } }
                </Show>
            } }>
            <comments::InlineComposer state=comments_state/>
        </Show>
    }.into_any()
}
fn card_view(id: String, cards: Memo<Vec<Card>>, active: Memo<String>, composer: Memo<comments::Composing>, comments_state: Signal<comments::State>, viewing: Memo<bool>) -> impl IntoView {
    let card = {
        let id = id.clone();
        Memo::new(move |_| cards.with(|list| list.iter().find(|c| c.id == id).cloned().unwrap_or_default()))
    };
    let suggestion = card.with_untracked(|c| c.kind == "suggestion");
    let (class_id, tool_id, data_id, body_id) = (id.clone(), id.clone(), id.clone(), id);
    let class = move || {
        let is_active = active.with(|a| *a == class_id);
        let composing = composer.with(|c| card.with(|card| composing_in(card, c)));
        format!("review-card{}{}", if is_active { " active" } else { "" }, if is_active || composing { " expanded" } else { "" })
    };
    let tools = if suggestion { None } else {
        let id = tool_id;
        Some(view! {
            <div class="review-card-tools">
                {move || {
                    let id = id.clone();
                    let (resolved, detached, incomplete, message) = card.with(|c| (c.status == "resolved", c.detached, c.status == "incomplete", c.messages.first().cloned().unwrap_or_default()));
                    let (decide, reattach) = (id.clone(), id);
                    let label = if resolved { "Reopen" } else { "Resolve" };
                    let extra = (detached && !incomplete).then(|| view! { <button type="button" on:click=move |_| crate::action("comment-reattach", &reattach)>"Reattach to selection"</button> }.into_any());
                    view! {
                        <button type="button" class="review-icon-button" hidden=incomplete aria-label=label title=label on:click=move |_| crate::action(if resolved { "comment-reopen" } else { "comment-resolve" }, &decide)>{icon(if resolved { "reopen" } else { "resolve" })}</button>
                        {message_menu(&message, extra)}
                    }
                }}
            </div>
        })
    };
    view! {
        <article class=class data-card-id=data_id style=move || card.with(|c| format!("--card-author:{}", c.colour)) aria-label=if suggestion { "Suggestion" } else { "Comment" }>
            <div class="review-card-head">
                <span class="review-avatar" class:agent=move || card.with(|c| c.agent) aria-hidden="true">{move || card.with(|c| c.initials.clone())}</span>
                <span class="review-who"><strong class="review-author">{move || card.with(|c| c.author.clone())}</strong>
                    <time datetime=move || card.with(|c| c.time_iso.clone()) title=move || card.with(|c| c.time_title.clone())>{move || card.with(|c| c.time.clone())}</time>
                    <Show when=move || card.with(|c| c.conflicted || c.status == "conflicted")><span class="review-badge warning">"Conflicted"</span></Show>
                    <Show when=move || card.with(|c| c.detached)><span class="review-badge warning">"Detached"</span></Show>
                    <Show when=move || card.with(|c| c.status == "resolved")><span class="review-badge">"Resolved"</span></Show>
                </span>
                {tools}
            </div>
            {(!suggestion).then(|| view! { <Show when=move || card.with(|c| c.status == "incomplete")><p class="review-card-note">"Suggestion unavailable. Its discussion is retained."</p></Show> })}
            {suggestion.then(|| suggestion_body(card, body_id.clone(), viewing))}
            {discussion_body(card, body_id, composer, active, comments_state, suggestion)}
        </article>
    }
}
#[component]
pub fn Panel(state: Signal<State>, comments: Signal<comments::State>, children: ChildrenFn) -> impl IntoView {
    let cards = Memo::new(move |_| state.get().cards);
    let active = Memo::new(move |_| state.get().active);
    let files = Memo::new(move |_| state.get().files);
    let tab = Memo::new(move |_| state.get().tab);
    let filter = Memo::new(move |_| state.get().filter);
    let tools = Memo::new(move |_| comments.get().open);
    let composer = Memo::new(move |_| comments.with(comments::State::composing_view));
    let viewing = Memo::new(move |_| state.get().mode == "viewing");
    let render = move |id: String| card_view(id, cards, active, composer, comments, viewing);
    let no_suggestions = move || viewing.get() || cards.with(|list| !list.iter().any(|c| c.kind == "suggestion" && !c.resolved));
    // A reply whose card is filtered out still needs somewhere to appear.
    let free_composer = move || composer.with(|c| c.inline && (c.mode == "create" || cards.with(|list| !list.iter().any(|card| composing_in(card, c)))));
    let actions = move || view! {
        <button type="button" on:click=move |_| crate::action("review-comment", "")>"Add comment"</button>
        <button type="button" disabled=no_suggestions on:click=move |_| crate::action("review-accept-visible", "")>"Accept all"</button>
        <button type="button" disabled=no_suggestions on:click=move |_| crate::action("review-reject-visible", "")>"Reject all"</button>
        <hr/>
        <button type="button" aria-expanded=move || tools.get().to_string() aria-controls="review-tools" on:click=move |_| crate::action("comment-toggle", "")>"Review tools"</button>
    }.into_any();
    let empty_message = move || {
        match (tab.get().as_str(), filter.get().as_str()) {
            (_, "resolved") => "No resolved items here yet.",
            ("overview", _) => "Nothing open in this project.",
            _ => match state.get().mode.as_str() {
                "reviewing" => "Type in the editor to suggest a change, or select text to add a comment.",
                "viewing" => "Read only. Select text in the editor to add a comment.",
                _ => "Select text in the editor to add a comment. To suggest changes instead, switch to Reviewing.",
            },
        }
    };
    view! {
        <aside id="review-workspace" class="review-workspace" aria-label="Review panel" hidden=move || !state.get().open>
            <header class="review-header">
                <h2 class="sr-only">"Review"</h2>
                <div class="review-tools-title" hidden=move || !tools.get()>
                    <button type="button" class="review-icon-button" aria-label="Close review tools" title="Back to cards" on:click=move |_| crate::action("comment-toggle", "")>{icon("back")}</button>
                    <h3>"Review tools"</h3>
                </div>
                <div class="review-tabs" role="tablist" aria-label="Review scope" hidden=move || tools.get()>
                    <button type="button" role="tab" aria-selected=move || (tab.get()=="file").to_string() on:click=move |_| crate::action("review-tab", "file")>"Current file"</button>
                    <button type="button" role="tab" aria-selected=move || (tab.get()=="overview").to_string() on:click=move |_| crate::action("review-tab", "overview")>"Overview"</button>
                </div>
                <span class="review-filter" hidden=move || tools.get()><span class="review-filter-label" aria-hidden="true">{move || match filter.get().as_str() { "resolved" => "Resolved", "all" => "All", _ => "Open" }}</span><select aria-label="Review status filter" prop:value=move || filter.get() on:change=move |e| crate::action("review-filter", &event_target_value(&e))><option value="open">"Open"</option><option value="resolved">"Resolved"</option><option value="all">"All"</option></select></span>
                {menu("Review actions", actions())}
                <button type="button" class="review-icon-button" aria-label="Close review panel" title="Close" on:click=move |_| crate::action("review-toggle", "")>{icon("close")}</button>
            </header>
            <div class="review-announcement" class:quiet=move || state.get().status_quiet||state.get().status.is_empty()>
                <p role="status" aria-label="Tracked changes" aria-live="polite">{move || state.get().status}</p>
                <button type="button" class="review-icon-button" aria-label="Dismiss message" title="Dismiss" on:click=move |_| crate::action("review-status-dismiss", "")>{icon("close")}</button>
            </div>
            <Show when=move || !state.get().preview_url.is_empty()><a class="review-preview-link" href=move || state.get().preview_url download="suggestion-preview.pdf" title=move || state.get().preview_label>"Download suggestion preview PDF"</a></Show>
            <div class="review-panel-scroll" hidden=move || tools.get()>
                <Show when=move || {state.get().total>100}><p class="review-limit">{move || format!("Showing 100 of {}. Decisions apply to the cards shown; use Current file to narrow them.",state.get().total)}</p></Show>
                <Show when=move || cards.with(Vec::is_empty) && !free_composer()><p class="review-empty">{empty_message}</p></Show>
                <Show when=move || tab.get()=="overview" fallback=move || view! {
                    <div class="review-cards">
                        <Show when=free_composer><div class="review-composer-card" data-card-id="composer"><comments::InlineComposer state=comments/></div></Show>
                        <For each=move || cards.with(|list| list.iter().map(|c| c.id.clone()).collect::<Vec<_>>()) key=|id| id.clone() children=move |id| render(id)/>
                    </div>
                }>
                    <Show when=free_composer><div class="review-composer-card static" data-card-id="composer"><comments::InlineComposer state=comments/></div></Show>
                    <nav aria-label="Review files" class="review-files">
                        <For each=move || files.get() key=|f| f.id.clone() children=move |f| {
                            let (group, jump, path) = (f.id.clone(), f.id.clone(), f.path.clone());
                            let count = { let id = f.id.clone(); move || files.with(|all| all.iter().find(|file| file.id == id).map_or(0, |file| file.count)) };
                            let (label_count, class_count, badge_count) = (count.clone(), count.clone(), count);
                            let label_path = path.clone();
                            let ids = move || cards.with(|list| list.iter().filter(|c| c.group == group).map(|c| c.id.clone()).collect::<Vec<_>>());
                            view! { <section class="review-file-group">
                                <button type="button" class="review-file" class:zero=move || class_count()==0 disabled=jump.is_empty() aria-label=move || format!("{} ({})", label_path, label_count()) on:click=move |_| crate::action("review-file", &jump)><span class="review-file-path">{path}</span><span class="review-count">{badge_count}</span></button>
                                <For each=ids key=|id| id.clone() children=move |id| render(id)/>
                            </section> }
                        }/>
                    </nav>
                </Show>
            </div>
            <div id="review-tools" class="review-tools" hidden=move || !tools.get()>
                {children()}
            </div>
            <comments::Feedback state=comments/>
        </aside>
    }
}
