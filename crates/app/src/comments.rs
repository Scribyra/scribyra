use leptos::prelude::*;
use wasm_bindgen::prelude::*;
#[wasm_bindgen]
pub fn validate_comment_range(source: &str, start: usize, end: usize) -> Result<(), JsValue> {
    scribyra_core::comments::validate_range(source, start, end).map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub fn prepare_comment_command(command: &str) -> Result<String, JsValue> {
    let command =
        serde_json::from_str(command).map_err(|_| JsValue::from_str("Invalid comment command."))?;
    scribyra_core::comments::dispatch(&command)
        .map(|value| value.to_string())
        .map_err(|error| JsValue::from_str(&serde_json::to_string(&error).unwrap()))
}
#[wasm_bindgen]
pub fn authorize_comment_command(
    command: &str,
    state: &str,
    author_id: &str,
    rights: &str,
) -> Result<(), JsValue> {
    let command =
        serde_json::from_str(command).map_err(|_| JsValue::from_str("Invalid comment command."))?;
    let state =
        serde_json::from_str(state).map_err(|_| JsValue::from_str("Invalid discussion state."))?;
    let rights =
        serde_json::from_str(rights).map_err(|_| JsValue::from_str("Invalid comment rights."))?;
    scribyra_core::comments::authorize(&command, &state, author_id, &rights)
        .map_err(|error| JsValue::from_str(&serde_json::to_string(&error).unwrap()))
}
#[wasm_bindgen]
pub fn project_comments(state: &str) -> Result<String, JsValue> {
    let state =
        serde_json::from_str(state).map_err(|_| JsValue::from_str("Invalid discussion state."))?;
    Ok(scribyra_core::comments::project(&state).to_string())
}
#[derive(Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    enabled: bool,
    pub open: bool,
    author_name: String,
    draft: String,
    mentions: Vec<String>,
    mode: String,
    error: String,
    notice: String,
    filter: String,
    threads: Vec<Thread>,
    authors: Vec<Author>,
    more: bool,
    detail: Option<Thread>,
    pending_save: bool,
    pending_count: usize,
    reattaching: bool,
    composing: bool,
    thread_id: String,
    suggestion_id: String,
    compose_quote: String,
}
/// What the review cards need to place the single comment composer.
#[derive(Clone, Default, PartialEq)]
pub struct Composing {
    pub inline: bool,
    pub mode: String,
    pub thread_id: String,
    pub suggestion_id: String,
}
impl State {
    pub fn composing_view(&self) -> Composing {
        Composing {
            inline: self.enabled && self.composing && !self.open,
            mode: self.mode.clone(),
            thread_id: self.thread_id.clone(),
            suggestion_id: self.suggestion_id.clone(),
        }
    }
}
#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Thread {
    id: String,
    suggestion_id: Option<String>,
    status: String,
    anchor_status: String,
    narrowed: bool,
    reason: String,
    path: String,
    quote: String,
    decision_conflict: bool,
    incomplete: bool,
    message_count: usize,
    messages: Vec<Message>,
    more: bool,
}
#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Message {
    id: String,
    author_name: String,
    conflicted: bool,
    pending: bool,
    variants: Vec<Variant>,
}
#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Variant {
    id: String,
    body: String,
    redacted: bool,
    mentions: Vec<Mention>,
}
#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
struct Mention {
    id: String,
    name: String,
}
#[derive(Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Author {
    id: String,
    display_name: String,
    kind: String,
}
fn action(name: &str, value: &str) {
    super::action(name, value);
}
#[component]
pub fn Comments(state: Signal<State>) -> impl IntoView {
    view! {
        <Show when=move || state.get().enabled>
            <section class="comments-panel" aria-label="Comments">
                <Show when=move || state.get().open>
                    <div id="comments-content" class="tools-stack" on:keydown=move |e| {
                        if e.is_composing() || e.key_code()==229 || super::composing() { return; }
                        if e.key()=="Escape" { e.prevent_default(); e.stop_propagation(); action("comment-toggle", ""); }
                    }>
                        <div class="tools-card">
                            <div class="tools-head">
                                <h4>"Comment threads"</h4>
                                <label class="tools-inline"><span class="sr-only">"Show threads"</span><select aria-label="Show comment threads" prop:value=move || state.get().filter on:change=move |e| action("comment-filter", &event_target_value(&e))><option value="open">"Open"</option><option value="resolved">"Resolved"</option><option value="detached">"Detached"</option><option value="all">"All"</option></select></label>
                            </div>
                            <Show when=move || {state.get().pending_count>0}><p>{move || format!("{} messages are pending an incomplete thread. Export discussion for recovery.",state.get().pending_count)}</p></Show>
                            <ul class="comment-threads" aria-label="Comment threads">
                                <For each=move || state.get().threads key=|t| serde_json::to_string(t).unwrap() children=move |thread| {
                                    let id=thread.id.clone();let current=thread.id.clone();
                                    view! {<li><button class="comment-thread-link" aria-current=move || state.get().detail.is_some_and(|d| d.id==current).then_some("true") on:click=move |_| action("comment-open", &id)><strong>{thread.path}</strong><span>{format!("{} · {} · {} {}", thread.status, if thread.narrowed {"narrowed"} else {&thread.anchor_status}, thread.message_count, if thread.message_count==1 {"message"} else {"messages"})}</span><span class="comment-quote">{thread.quote}</span></button>
                                        <Show when=move || thread.anchor_status=="detached"><p class="comment-warning">{format!("Detached: {}",thread.reason.replace('_'," "))}</p></Show>
                                        <Show when=move || thread.decision_conflict><p class="comment-warning">"Decision conflict · thread remains open"</p></Show>
                                        <Show when=move || thread.incomplete><p>"Pending / incomplete references"</p></Show>
                                    </li>}
                                }/>
                            </ul>
                            <div class="tools-actions">
                                <button id="comment-new" on:click=move |_| action("comment-new", "")>"Comment on selection"</button>
                                <Show when=move || state.get().more><button on:click=move |_| action("comment-more", "")>"More threads"</button></Show>
                            </div>
                        </div>
                        <For each=move || state.get().detail.into_iter() key=|t| serde_json::to_string(t).unwrap() children=move |thread| {
                            let jump=thread.id.clone();let reattach=thread.id.clone();let reply=thread.id.clone();let decision=thread.id.clone();let resolved=thread.status=="resolved";let suggestion=thread.suggestion_id.is_some();
                            view! {<section class="comment-detail tools-card" aria-label="Selected comment thread"><h3>{thread.path}</h3>
                                <p class="tools-note">{format!("{} · {}",thread.status,thread.anchor_status)}</p><blockquote>{thread.quote}</blockquote>
                                <div class="tools-actions">
                                    <button disabled=thread.anchor_status!="attached" on:click=move |_| action("comment-jump", &jump)>"Show in source"</button>
                                    <button hidden=suggestion on:click=move |_| action("comment-reattach", &reattach)>"Reattach to selection"</button>
                                    <button hidden=suggestion on:click=move |_| action(if resolved {"comment-reopen"} else {"comment-resolve"}, &decision)>{if resolved {"Reopen thread"} else {"Resolve thread"}}</button>
                                </div>
                                <ol class="comment-messages" aria-label="Messages">
                                    {thread.messages.into_iter().map(|message| {
                                        let edit=message.id.clone();let redact=message.id.clone();
                                        view!{<li><strong>{message.author_name}</strong>
                                            <Show when=move || message.conflicted><p class="comment-warning">"Concurrent revisions · all alternatives shown"</p></Show>
                                            <Show when=move || message.pending><p>"Pending event parents"</p></Show>
                                            {message.variants.into_iter().map(|variant| view!{<div class="comment-variant"><p class="comment-body">{if variant.redacted {"Message redacted".into()} else {variant.body}}</p><ul class="comment-mentions" aria-label="Mentioned authors">{variant.mentions.into_iter().map(|mention| view!{<li>{format!("@{}",mention.name)}</li>}).collect_view()}</ul></div>}).collect_view()}
                                            <div class="tools-actions"><button on:click=move |_| action("comment-edit", &edit)>"Edit message"</button><button class="tools-danger" on:click=move |_| action("comment-redact", &redact)>"Redact message"</button></div>
                                        </li>}
                                    }).collect_view()}
                                </ol>
                                <div class="tools-actions">
                                    <Show when=move || thread.more><button on:click=move |_| action("comment-messages-more", "")>"More messages"</button></Show>
                                    <button on:click=move |_| action("comment-reply", &reply)>"Reply to thread"</button>
                                </div>
                            </section>}
                        }/>
                        <form class="tools-card" on:submit=move |e| {e.prevent_default();if !super::composing(){action("comment-send", "");}}>
                            <label for="comment-body" class="tools-title">{move || if state.get().mode=="edit" {"Edit comment"} else if matches!(state.get().mode.as_str(), "reply" | "suggestion") {"Reply"} else {"New comment"}}</label>
                            <textarea id="comment-body" aria-label="Comment body" disabled=move || state.get().pending_save prop:value=move || state.get().draft on:input=move |e| action("comment-draft", &event_target_value(&e)) on:keydown=move |e| {
                                if (e.ctrl_key()||e.meta_key()) && e.key()=="Enter" && !e.is_composing() && e.key_code()!=229 && !super::composing() {e.prevent_default();e.stop_propagation();action("comment-send", "");}
                            }/>
                            <details class="tools-disclosure"><summary>"Mention authors (local metadata)"</summary><For each=move || state.get().authors key=|a| (a.id.clone(),a.display_name.clone(),a.kind.clone()) children=move |author| {let id=author.id.clone();let checked=author.id.clone();view!{<label><input type="checkbox" prop:checked=move || state.get().mentions.contains(&checked) on:change=move |_| action("comment-mention", &id)/>{format!("{}{}",author.display_name,if author.kind=="agent" {" (agent)"}else{""})}</label>}}/></details>
                            <div class="tools-actions"><button id="comment-send" class="tools-primary" type="submit" disabled=move || state.get().pending_save>"Send comment"</button><button type="button" disabled=move || state.get().pending_save on:click=move |_| action("comment-clear", "")>"Clear draft"</button></div>
                        </form>
                        <div class="tools-card">
                            <details class="tools-disclosure"><summary>"Your author profile"</summary><label>"Display name"<input aria-label="Comment author name" prop:value=move || state.get().author_name maxlength="320" on:change=move |e| action("comment-author", &event_target_value(&e))/></label><p class="tools-note">"Local attribution; mentions are metadata and send no notifications."</p></details>
                            <hr/>
                            <p class="tools-note">"Discussion exports include original message bodies and redacted history."</p>
                            <div class="tools-actions"><button on:click=move |_| action("comment-export", "")>"Export discussion and draft"</button></div>
                        </div>
                    </div>
                </Show>
            </section>
        </Show>
    }
}
/// The compact composer used inside a card or the new-comment card. The tools
/// page keeps the full form; `State::composing_view` makes the two exclusive,
/// so `comment-body` and `comment-send` stay single elements.
#[component]
pub fn InlineComposer(state: Signal<State>) -> impl IntoView {
    let empty = move || state.with(|s| s.draft.trim().is_empty());
    let quote = move || state.with(|s| if s.mode == "create" { s.compose_quote.clone() } else { String::new() });
    let title = move || state.with(|s| match s.mode.as_str() { "edit" => "Edit comment", "create" => "New comment", _ => "" });
    view! {
        <form class="comment-inline" on:submit=move |e| {e.prevent_default();if !super::composing(){action("comment-send", "");}}>
            <Show when=move || !title().is_empty()><p class="comment-inline-title">{title}</p></Show>
            <Show when=move || !quote().is_empty()><p class="review-quote">{quote}</p></Show>
            <textarea id="comment-body" rows="2" aria-label="Comment body" placeholder=move || state.with(|s| if s.mode=="reply" || s.mode=="suggestion" {"Reply…"} else {"Add your comment…"}) disabled=move || state.get().pending_save prop:value=move || state.get().draft on:input=move |e| action("comment-draft", &event_target_value(&e)) on:keydown=move |e| {
                if e.is_composing() || e.key_code()==229 || super::composing() { return; }
                if e.key()=="Enter" && !e.shift_key() {e.prevent_default();e.stop_propagation();if !state.with_untracked(|s| s.draft.trim().is_empty()) {action("comment-send", "");}}
                if e.key()=="Escape" && state.with_untracked(|s| s.draft.is_empty()) {e.prevent_default();e.stop_propagation();action("comment-cancel", "");}
            }/>
            <div class="comment-inline-actions">
                <button type="button" class="review-reject" disabled=move || state.get().pending_save on:click=move |_| action("comment-cancel", "")>"Cancel"</button>
                <button id="comment-send" type="submit" class="review-accept" aria-label="Send comment" disabled=move || empty()||state.get().pending_save>{move || state.with(|s| match s.mode.as_str() { "edit" => "Save", "reply" | "suggestion" => "Reply", _ => "Comment" })}</button>
            </div>
        </form>
    }
}
/// Messages that must stay reachable whichever view of the panel is showing.
#[component]
pub fn Feedback(state: Signal<State>) -> impl IntoView {
    view! {
        <div class="comments-panel comment-feedback">
            <Show when=move || state.get().reattaching><div class="comment-reattach" role="group" aria-label="Confirm reattachment"><p>"Attach this comment to the current selection?"</p><button id="comment-confirm-reattach" class="review-accept" on:click=move |_| action("comment-confirm-reattach", "")>"Confirm reattach"</button><button class="review-reject" on:click=move |_| action("comment-cancel-reattach", "")>"Cancel reattach"</button></div></Show>
            <Show when=move || !state.get().error.is_empty()><p role="alert" class="comment-warning">{move || state.get().error}</p></Show>
            <Show when=move || state.get().pending_save><button id="comment-retry-save" class="review-accept" on:click=move |_| action("comment-save", "")>"Retry local save"</button></Show>
            <Show when=move || state.get().pending_save && !state.get().open><button class="review-reject" on:click=move |_| action("comment-export", "")>"Export discussion and draft"</button></Show>
            <p class="sr-only" role="status" aria-label="Comment status" aria-live="polite">{move || state.get().notice}</p>
        </div>
    }
}
