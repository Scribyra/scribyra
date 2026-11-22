// SHA-1 in plain JavaScript, for Git object ids. The plugin sandbox's worker is not a
// secure context in Chromium, so crypto.subtle is missing there (docs/plugins.md, notes
// for authors). Git names a file's content by SHA-1("blob <size>\0" + bytes); comparing
// those ids tells which files differ from a commit without downloading them.
function rotl(x,n){return (x<<n)|(x>>>(32-n));}
export function sha1Hex(bytes){
  const length=bytes.length,total=((length+9+63)>>>6)<<6,data=new Uint8Array(total);
  data.set(bytes);data[length]=0x80;
  const view=new DataView(data.buffer),bits=length*8;
  view.setUint32(total-8,Math.floor(bits/0x100000000));view.setUint32(total-4,bits>>>0);
  let h0=0x67452301,h1=0xefcdab89,h2=0x98badcfe,h3=0x10325476,h4=0xc3d2e1f0;const w=new Uint32Array(80);
  for(let offset=0;offset<total;offset+=64){
    for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4);
    for(let i=16;i<80;i++)w[i]=rotl(w[i-3]^w[i-8]^w[i-14]^w[i-16],1);
    let a=h0,b=h1,c=h2,d=h3,e=h4;
    for(let i=0;i<80;i++){
      const f=i<20?(b&c)|(~b&d):i<40?b^c^d:i<60?(b&c)|(b&d)|(c&d):b^c^d;
      const k=i<20?0x5a827999:i<40?0x6ed9eba1:i<60?0x8f1bbcdc:0xca62c1d6;
      const t=(rotl(a,5)+f+e+k+w[i])>>>0;e=d;d=c;c=rotl(b,30)>>>0;b=a;a=t;
    }
    h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;h4=(h4+e)>>>0;
  }
  return [h0,h1,h2,h3,h4].map(h=>h.toString(16).padStart(8,'0')).join('');
}
/** The Git blob id of these bytes. */
export function gitBlobId(bytes){
  const header=new TextEncoder().encode(`blob ${bytes.length}\0`),all=new Uint8Array(header.length+bytes.length);
  all.set(header);all.set(bytes,header.length);return sha1Hex(all);
}
