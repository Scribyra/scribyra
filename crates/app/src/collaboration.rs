//! WASM bridge for the internal collaboration foundation, separate from v1.
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn agent_limits() -> String {
    scribyra_core::agent::limits().to_string()
}
#[wasm_bindgen]
pub fn collaboration_versions() -> String {
    scribyra_core::collaboration_schema::versions().to_string()
}
#[wasm_bindgen]
pub fn collaboration_lineage(project_id: &str) -> String {
    scribyra_core::collaboration_schema::lineage(project_id)
}
#[wasm_bindgen]
pub fn validate_collaboration_state(state: &str) -> Result<(), JsValue> {
    scribyra_core::collaboration_schema::validate_state(state).map_err(|e| JsValue::from_str(&e))
}
#[wasm_bindgen]
pub fn validate_collaboration_command(request: &str, context: &str) -> Result<String, JsValue> {
    scribyra_core::collaboration_commands::validate(request, context)
        .map(|(request, policy)| serde_json::json!({"request":request,"policy":policy}).to_string())
        .map_err(|e| JsValue::from_str(&serde_json::to_string(&e).unwrap()))
}
#[wasm_bindgen]
pub fn validate_collaboration_migration(before: &str, after: &str) -> Result<(), JsValue> {
    scribyra_core::collaboration_schema::validate_migration(before, after)
        .map_err(|e| JsValue::from_str(&e))
}
