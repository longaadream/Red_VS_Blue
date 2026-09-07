// One-time migration evidence against the refreshed implementation baseline.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),base='afbbda5f1d4f7179ec2b2d3a81fceaee9fb157a8';
// Three pages now intentionally share a card renderer; their behavior is covered by runtime tests.
const pages=fs.readdirSync(path.join(root,'data/pages')).filter(f=>f.endsWith('.html')&&!['battle.html','pieces.html','piece-selection.html'].includes(f));
const normalize=s=>s.replace(/\r\n/g,'\n');
for(const page of pages){
 const file='data/pages/'+page,source=fs.readFileSync(path.join(root,file),'utf8'),old=execFileSync('git',['show',base+':'+file],{cwd:root,encoding:'utf8',maxBuffer:4e6});
 const withoutArt=source.replace(/ data-art-page="[^"]+"/g,'').replace(/^[ \t]*<link rel="stylesheet" href="css\/tabletop\/(tabletop|menu)\.css" \/>\r?\n/gm,'');
 assert.equal(normalize(withoutArt),normalize(old),page+': all original markup, styles, inline scripts and handlers must be unchanged');
}
const styles=['tabletop/tabletop.css','tabletop/menu.css','tabletop/related-hand-cards.css','battle-context-ui.css','battle-tactical-table.css'];
let assets=0;for(const name of styles){
 const file=path.join(root,'data/pages/css',name),css=fs.readFileSync(file,'utf8');require(path.join(root,'node_modules/postcss')).parse(css,{from:file});
 for(const match of css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)){assert(fs.existsSync(path.resolve(path.dirname(file),match[1])),match[1]+' must resolve locally');assets++;}
}
const result={base,htmlPagesPreserved:pages.length,sharedCardPages:['battle.html','pieces.html','piece-selection.html'],cssParsed:styles.length,localAssetReferences:assets,fontLicense:fs.existsSync(path.join(root,'data/pages/images/tabletop/OFL.txt'))};
fs.writeFileSync(path.join(__dirname,'static-verification.json'),JSON.stringify(result,null,2)+'\n');console.log(result);
