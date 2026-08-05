// 测试不同格式是否被透明加密软件篡改
const fs = require('fs');
const path = require('path');

function check(file) {
  const b = fs.readFileSync(file);
  console.log(file, '-> header:', b.slice(0, 8).toString('hex'), 'size:', b.length);
}

// 1. CSV 测试
fs.writeFileSync(path.join(__dirname, 'test.csv'), 'a,b,c\n1,2,3\n');
// 2. txt 伪装 xlsx（改后缀）
fs.writeFileSync(path.join(__dirname, 'test.dat'), 'PK\x03\x04testdata');
// 3. 纯 txt
fs.writeFileSync(path.join(__dirname, 'test.txt'), 'hello world');

console.log('=== 写入后立即检查 ===');
check('test.csv');
check('test.dat');
check('test.txt');
