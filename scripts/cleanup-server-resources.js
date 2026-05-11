/**
 * cleanup-server-resources.js
 * 打包完成后删除临时目录 _standalone。
 */
const fs = require('fs')
const path = require('path')

const dst = path.join(__dirname, '..', '_standalone')
if (fs.existsSync(dst)) {
  fs.rmSync(dst, { recursive: true, force: true })
  console.log('[cleanup] Removed _standalone.')
}
