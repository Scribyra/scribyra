import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { service } from '../helpers/service.mjs';

async function peers(browser,s) {
  const type=browser.browserType(),name=type.name();
  const executablePath=process.env[`PLAYWRIGHT_${name.toUpperCase()}_EXECUTABLE_PATH`]||undefined;
  const second=await type.launch({executablePath,...(name==='chromium'?{args:['--no-sandbox']}: {})});
  const contexts=await Promise.all([browser.newContext(),second.newContext()]);
  const close=async()=>{await Promise.all(contexts.map(c=>c.close()));await second.close();};
  try {
  if(name==='chromium')for(const context of contexts)await context.grantPermissions(['local-network-access']);
  const pages=await Promise.all(contexts.map(c=>c.newPage()));
  const source=await readFile('web/service-client.js','utf8');
  for(const page of pages) {
    await page.route('**/service-harness',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Service test</title>'}));
    await page.route('**/service-client.js',route=>route.fulfill({contentType:'text/javascript',body:source}));
    await page.goto('/service-harness');
    await page.evaluate(async()=>{
      window.api=await import('/service-client.js');window.errors=[];window.received=[];window.sent=[];
      const Original=WebSocket;window.WebSocket=class extends Original {
        constructor(...args){super(...args);window.socket=this;}
        send(value){if(value instanceof Uint8Array)window.sent.push(Array.from(value));super.send(value);}
      };
    });
  }
  const invitation=await pages[0].evaluate(()=>api.createInvitation());
  for(const page of pages)await page.evaluate(async({url,bearer,invitation})=>{
    window.relay=await api.connectService({endpoint:url,bearer,invitation,onSignal:value=>{received.push(value);return window.signal?.(value);},onError:error=>errors.push(error.message)});
  },{url:s.url,bearer:s.bearer,invitation});
  return {pages,close};
  } catch(error) {await close();throw error;}
}

test('two separate browsers exchange immediate offer, answer and trickled ICE through the opaque service',async({browser},testInfo)=>{
  // Linux WebKit cannot complete local WebRTC here, with or without this service (docs/reorientation/r1-collaboration.md). Real Safari is still to be tested under D.
  test.skip(testInfo.project.name==='webkit','Linux WebKit cannot complete local WebRTC connections.');
  const s=await service();let pair;
  try {
    pair=await peers(browser,s);const [a,b]=pair.pages;
    for(const page of pair.pages)await page.evaluate(()=>{
      window.pc=new RTCPeerConnection({iceServers:[]});window.candidates=[];window.candidateCount=0;window.channelMessages=[];
      function channel(dc){window.dc=dc;dc.onmessage=e=>channelMessages.push(e.data);}
      pc.ondatachannel=e=>channel(e.channel);window.attachChannel=channel;
      pc.onicecandidate=e=>{if(e.candidate){candidateCount++;relay.send({type:'candidate',candidate:e.candidate.toJSON()});}};
      window.signal=async value=>{
        if(value.type==='candidate'){if(!pc.remoteDescription)candidates.push(value.candidate);else await pc.addIceCandidate(value.candidate);return;}
        await pc.setRemoteDescription(value);window.remoteAt=performance.now();
        for(const candidate of candidates.splice(0))await pc.addIceCandidate(candidate);
        if(value.type==='offer'){
          await pc.setLocalDescription(await pc.createAnswer());
          window.answerApplied=true;
          await relay.send({type:'answer',sdp:pc.localDescription.sdp});
        }
      };
    });
    await a.evaluate(async()=>{attachChannel(pc.createDataChannel('test'));await pc.setLocalDescription(await pc.createOffer());window.offerSentAt=performance.now();await relay.send({type:'offer',sdp:pc.localDescription.sdp});});
    await expect.poll(()=>a.evaluate(()=>pc.connectionState),{timeout:20000}).toBe('connected');
    for(const page of pair.pages) {
      await expect.poll(()=>page.evaluate(()=>dc?.readyState),{timeout:10000}).toBe('open');
      expect(await page.evaluate(()=>candidateCount)).toBeGreaterThan(0);
      expect(await page.evaluate(()=>errors)).toEqual([]);
    }
    const milliseconds=await a.evaluate(()=>remoteAt-offerSentAt);
    expect(milliseconds).toBeLessThan(1500);
    expect(await b.evaluate(()=>answerApplied)).toBe(true);
    const message='direct-'+await a.evaluate(()=>api.randomId());
    await a.evaluate(value=>dc.send(value),message);await expect.poll(()=>b.evaluate(()=>channelMessages)).toEqual([message]);
    await b.evaluate(value=>dc.send(value),message);await expect.poll(()=>a.evaluate(()=>channelMessages)).toEqual([message]);
    for(const page of pair.pages)await page.evaluate(()=>{pc.close();relay.close();});
    await testInfo.attach('signaling-time',{body:JSON.stringify({milliseconds,iceServers:[],browserProcesses:2}),contentType:'application/json'});
    expect(s.logs).not.toContain(message);
  } finally {await pair?.close();await s.close();}
});

for(const attack of ['tamper','replay'])test(`client rejects ${attack} from the relay before delivering signaling`,async({browser})=>{
  const s=await service();let pair;
  try {
    pair=await peers(browser,s);const [a,b]=pair.pages;
    await a.evaluate(()=>relay.send({type:'offer',sdp:'PRIVATE_SIGNAL_FINGERPRINT'}));
    await expect.poll(()=>b.evaluate(()=>received.length)).toBe(1);
    await a.evaluate(attack=>{
      const bytes=new Uint8Array(sent[0]);
      if(attack==='tamper') {const frame=JSON.parse(new TextDecoder().decode(bytes));frame.sequence++;frame.ciphertext=(frame.ciphertext[0]==='0'?'1':'0')+frame.ciphertext.slice(1);socket.send(new TextEncoder().encode(JSON.stringify(frame)));}
      else socket.send(bytes);
    },attack);
    await expect.poll(()=>b.evaluate(()=>errors.length)).toBe(1);
    expect(await b.evaluate(()=>received.length)).toBe(1);
    const transmitted=await a.evaluate(()=>new TextDecoder().decode(new Uint8Array(sent[0])));
    expect(transmitted).not.toContain('PRIVATE_SIGNAL_FINGERPRINT');
  } finally {await pair?.close();await s.close();}
});
