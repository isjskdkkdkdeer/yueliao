import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=readFileSync('dist/app.js','utf8');
const context={};vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function numericChatID'),source.indexOf('const avatar=')),context);
for(const id of ['yueliao-00000000','yueliao-00000001','yueliao-1234abcd','yueliao-ffffffff']){
 const number=context.numericChatID(id);assert.match(number,/^\d{10}$/);assert.equal(context.peerChatID(number),id);assert.equal(context.peerChatID(id),id);
}
assert.equal(context.peerChatID('9999999999'),'9999999999');
console.log('PASS numeric IDs: exact reversible mapping, leading zeros and legacy friend compatibility');
