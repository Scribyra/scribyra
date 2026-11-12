// Only official Pages builds receive these; default and self-hosted builds stay silent.
import {parseSessionRate,SESSION_RATES} from '../web/telemetry-session.js';
export const officialTelemetryEndpoint='https://faro-collector-prod-eu-central-0.grafana.net/collect/92935ef8d0bc1065ae2621b09f0a6b6e';
export const officialTelemetryEnv={
 VITE_TELEMETRY_INGEST_URL:officialTelemetryEndpoint,
 VITE_TELEMETRY_DESTINATION_LABEL:'Grafana Cloud, a third-party service, in the EU region',
 VITE_TELEMETRY_ABOUT_URL:'/telemetry.html',
};
// The share of sessions that send, from the CI variable SCRIBYRA_TELEMETRY_SESSION_RATE.
// Only the official build reads it; unset or empty means every session.
export function officialSessionRateEnv(value){
 const rate=parseSessionRate(value);
 if(Number.isNaN(rate))throw Error(`SCRIBYRA_TELEMETRY_SESSION_RATE must be one of ${SESSION_RATES.join(', ')}.`);
 return{VITE_TELEMETRY_SESSION_RATE:String(rate)};
}
