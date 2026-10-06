// 阈值行为校验的 CJS 运行器。
// 配合 `tsc -p scripts/tsconfig.check.json` 使用：编译产物在 scripts/.build 下，
// 运行器复制到产物目录后执行（见 package.json 的 check:threshold 脚本）。
// 作用：把源码里的 @/ 别名解析到 scripts/.build/src。
const Module = require('module')
const path = require('path')
const buildSrc = path.join(__dirname, '..', 'src')
const orig = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@/')) {
    request = path.join(buildSrc, request.slice(2))
  }
  return orig.call(this, request, ...rest)
}
require(path.join(__dirname, 'check-threshold.js'))
