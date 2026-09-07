// Format/size packaging only. All illustration and retouching is done by built-in ImageGen.
const fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const root = path.resolve(__dirname, '../../..');
const sourceDir = process.argv[2];
if (!sourceDir) throw Error('Pass the ImageGen output directory');
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'portraits.json'), 'utf8'));
(async () => {
  for (const row of rows) {
    if (!/^exec-[a-z0-9-]+\.png$/.test(row.source) || !/^(public|data\/pages\/images)\/[a-z0-9-]+\.(jpg|png)$/.test(row.destination)) throw Error('Invalid asset path');
    const target = path.resolve(root, row.destination);
    const pipeline = sharp(path.join(sourceDir, row.source)).resize(512, 512, {fit:'contain'});
    await (target.endsWith('.png') ? pipeline.png() : pipeline.jpeg({quality:92})).toFile(target);
  }
  console.log('Packaged ' + rows.length + ' portraits with unchanged resource names.');
})().catch(error => { console.error(error); process.exitCode = 1; });
