use leptos::prelude::*;
use wasm_bindgen::prelude::*;
#[wasm_bindgen]
pub fn validate_review_command(command: &str) -> Result<String, JsValue> {
    let value = serde_json::from_str(command).map_err(|e| JsValue::from_str(&e.to_string()))?;
    scribyra_core::reviews::command(&value)
        .map(|v| v.to_string())
        .map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub fn validate_review_package(encoded: &str) -> Result<(), JsValue> {
    scribyra_core::reviews::validate_package(encoded).map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub fn review_exchange_state(encoded: &str) -> Result<String, JsValue> {
    let state = serde_json::from_str(encoded).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    scribyra_core::reviews::exchange_state(&state)
        .and_then(|state| serde_json::to_string(&state).map_err(|e| e.to_string()))
        .map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub fn review_digest(value: &str) -> String {
    scribyra_core::reviews::digest(value)
}
#[wasm_bindgen]
pub fn review_projection(target: &str, events: &str) -> Result<String, JsValue> {
    let events: Vec<serde_json::Value> =
        serde_json::from_str(events).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(scribyra_core::reviews::project(target, &events).to_string())
}
#[derive(Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    enabled: bool,
    recovery: bool,
    status: String,
    reviews: Vec<Row>,
    suggestions: Vec<Row>,
    preview_url: String,
    preview_label: String,
    preview_busy: bool,
    undo_id: String,
    redo_id: String,
}
#[derive(Clone, Default, serde::Deserialize)]
#[serde(default)]
struct Row {
    id: String,
    title: String,
    status: String,
    author: String,
    authority: String,
    before: String,
    after: String,
}
#[component]
pub fn Reviews(state: Signal<State>) -> impl IntoView {
    let (title, set_title) = signal(String::new());
    let (after, set_after) = signal(String::new());
    view! { <Show when=move || state.get().enabled fallback=move || view! {
        <p role="status" aria-label="Review status">{move || state.get().status}</p>
    }>
        <details class="reviews-panel tools-card"><summary>"Reviews and proposed changes"</summary>
        <section aria-label="Reviews" class="tools-sections">
            <p class="tools-note">"Proposals stay outside accepted source until accepted. Attribution is descriptive, not verified identity."</p>
            <div class="tools-group">
                <h4>"New review"</h4>
                <label>"Review title"<input maxlength="160" prop:value=title on:input=move |e|set_title.set(event_target_value(&e))/></label>
                <div class="tools-actions"><button class="tools-primary" on:click=move |_|crate::action("review.create",&title.get())>"Create review"</button></div>
            </div>
            <div class="tools-group">
                <h4>"Proposed text"</h4>
                <label>"Replacement text (empty deletes selection)"<textarea prop:value=after on:input=move |e|set_after.set(event_target_value(&e))/></label>
                <p class="tools-note">"Select source in the editor, then propose it in a review below. An empty selection inserts text."</p>
            </div>
            <For each=move || state.get().reviews key=|r|format!("{}:{}:{}:{}",r.id,r.status,r.title,r.authority) children=move |r| {
                let propose=r.id.clone();let submit=r.id.clone();let close=r.id.clone();let export=r.id.clone();
                view!{<article class="tools-item"><div class="tools-head"><h3>{r.title}</h3><span class="review-badge">{r.status}</span></div><p class="tools-note">{r.authority}</p>
                    <div class="tools-actions">
                        <button class="tools-primary" on:click=move |_|crate::action("review.propose",&serde_json::json!({"reviewId":propose,"after":after.get()}).to_string())>"Propose selected source"</button>
                        <button on:click=move |_|crate::action("review.submit",&submit)>"Submit review"</button>
                        <button on:click=move |_|crate::action("review.close",&close)>"Close review"</button>
                        <button on:click=move |_|crate::action("review.export",&export)>"Export review package"</button>
                    </div>
                </article>}
            }/>
            <For each=move || state.get().suggestions key=|r|format!("{}:{}",r.id,r.status) children=move |r| {
                let accept=r.id.clone();let reject=r.id.clone();let withdraw=r.id.clone();let preview=r.id.clone();
                view!{<article class="tools-item"><h3>{r.title}</h3><p class="tools-note">{r.author}" · "{r.status}</p><del><pre>{r.before}</pre></del><ins><pre>{r.after}</pre></ins>
                    <div class="tools-actions">
                        <button class="tools-primary" on:click=move |_|crate::action("suggestion.accept",&accept)>"Accept suggestion"</button>
                        <button on:click=move |_|crate::action("suggestion.reject",&reject)>"Reject suggestion"</button>
                        <button on:click=move |_|crate::action("suggestion.withdraw",&withdraw)>"Withdraw suggestion"</button>
                        <button on:click=move |_|crate::action("review.preview",&preview)>"Preview suggestion"</button>
                    </div>
                </article>}
            }/>
            <div class="tools-group">
                <h4>"Batch decisions"</h4>
                <div class="tools-actions">
                    <button on:click=move |_|crate::action("review.acceptAll","")>"Accept displayed pending suggestions"</button>
                    <button disabled=move || state.get().undo_id.is_empty() on:click=move |_|crate::action("change.undo",&state.get().undo_id)>"Undo acceptance batch"</button>
                    <button disabled=move || state.get().redo_id.is_empty() on:click=move |_|crate::action("change.redo",&state.get().redo_id)>"Redo acceptance batch"</button>
                    <button disabled=move || !state.get().recovery on:click=move |_|crate::action("review.retry","")>"Retry unsaved decision"</button>
                </div>
            </div>
            <div class="tools-group">
                <h4>"Exchange package"</h4>
                <div class="tools-actions">
                    <button on:click=move |_|crate::action("review.importFile","")>"Import review package"</button>
                    <button on:click=move |_|crate::action("review.confirmImport","")>"Confirm review import plan"</button>
                </div>
            </div>
            <div class="tools-group">
                <h4>"Isolated preview"</h4>
                <div class="tools-actions">
                    <button disabled=move || !state.get().preview_busy on:click=move |_|crate::action("review.cancel","")>"Cancel review preview"</button>
                    <Show when=move || !state.get().preview_url.is_empty()><a href=move || state.get().preview_url download=move || format!("{}.pdf",state.get().preview_label)>"Download isolated preview PDF"</a></Show>
                </div>
                <p class="tools-note">{move || state.get().preview_label}</p>
            </div>
            <p class="tools-note" role="status" aria-label="Review status">{move || state.get().status}</p>
        </section></details>
    </Show> }
}
