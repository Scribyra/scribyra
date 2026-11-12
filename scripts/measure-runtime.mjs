// Reproduce file-size measurements after `npm run build`; no browser/private data.
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {texRuntimeAssets,texRuntimeIdentity} from './tex-environment.mjs';
const root='public/core/busytex',manifest=JSON.parse(readFileSync(join(root,'lualatex-manifest.json')));
const components=JSON.parse(readFileSync(join(root,manifest.components.path))),assets=texRuntimeAssets();
const metadata=JSON.parse(readFileSync(join(root,manifest.metadata.path))),fileShards=Object.values(metadata.filenames),packageShards=Object.values(metadata.packages);
const supportAssets=metadata.support?.assets||[],supportRuntimeAssets=supportAssets.filter(asset=>!asset.path.endsWith('.source.tar.xz')),supportSourceAssets=supportAssets.filter(asset=>asset.path.endsWith('.source.tar.xz'));
const legacyMetadataBytes=statSync('web/tex-catalog.json.gz').size+manifest.components.size;
function directoryBytes(path){return readdirSync(path,{withFileTypes:true}).reduce((sum,entry)=>sum+(entry.isDirectory()?directoryBytes(join(path,entry.name)):entry.isFile()?statSync(join(path,entry.name)).size:0),0);}
const sum=files=>files.reduce((n,file)=>n+file.size,0);
console.log(JSON.stringify({
 version:1,runtime:texRuntimeIdentity(),
 methodology:'Generated file sizes before HTTP compression. Not total network transfer, browser cache use, or a peak-memory measurement. Core excludes the app shell and separately cached metadata; Biber is separate. Optional archives/shards are stored on the host, fetched only when needed.',
 originalDataBytes:manifest.sourceDataBytes,baselineDataBytes:manifest.data.size,
 baselineExpandedBytes:manifest.uncompressedBytes,baselineFiles:manifest.fileCount,
 baselineReductionPercent:Math.round((1-manifest.data.size/manifest.sourceDataBytes)*1000)/10,
 coreBytes:sum(assets.core),biberBytes:sum(assets.biber),
 componentIndexBytes:manifest.components.size,components:Object.keys(components.packages).length,
 allOptionalArchiveBytes:sum(Object.values(components.packages))+sum(supportRuntimeAssets),distributionOptionalArchiveBytes:sum(Object.values(components.packages)),fontAliases:Object.keys(components.fontFamilies||{}).length,
 supportRuntimePackages:supportRuntimeAssets.length,supportRuntimeBytes:sum(supportRuntimeAssets),supportSourceBytes:sum(supportSourceAssets),
 metadataRootBytes:manifest.metadata.size,metadataPackageCount:metadata.packageCount,metadataBasenameCount:metadata.filenameCount,
 metadataFilenameShards:fileShards.length,metadataPackageShards:packageShards.length,
 metadataFilenameShardBytes:sum(fileShards),metadataPackageShardBytes:sum(packageShards),
 metadataLargestShardBytes:Math.max(...fileShards.map(p=>p.size),...packageShards.map(p=>p.size)),
 legacyEagerMetadataBytes:legacyMetadataBytes,metadataStartupReductionPercent:Math.round((1-manifest.metadata.size/legacyMetadataBytes)*1000)/10,
 staticDeploymentBytes:directoryBytes('dist'),coreAssets:assets.core,biberAssets:assets.biber,
 notices:manifest.notices,
},null,2));
