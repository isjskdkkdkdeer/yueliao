import {generateKeyPairSync} from 'node:crypto';
const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const jwk=privateKey.export({format:'jwk'});
const publicKey=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]).toString('base64url');
console.log(JSON.stringify({VAPID_PUBLIC_KEY:publicKey,VAPID_PRIVATE_KEY:jwk.d,VAPID_SUBJECT:'mailto:replace-with-your-email@example.com'},null,2));
