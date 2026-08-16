import assert from 'assert';
import { config, getSystemPrompt } from '../src/config.js';
import { db } from '../src/utils/db.js';
import { aiProvider, AIProviderManager } from '../src/ai/provider.js';
import permissionChecker from '../src/utils/permissionChecker.js';
import adminCommands from '../src/commands/admin.js';
import { sessionManager, botEngine, BoundedTtlSet, UserBotSession } from '../src/bot.js';
import { encrypt, decrypt, hashPassword, verifyPassword } from '../src/utils/crypto.js';
import { createServer } from '../src/server.js';
import { createSignedHeaders, createSignature, verifySignature } from '../src/utils/internalAuth.js';

console.log('=== RUNNING MULTI-TENANT ISOLATION, BYOK & AI RELIABILITY TEST SUITE ===\n');

// =========================================================================
// Test 1: BYOK API Key Encryption & Decryption at Rest
// =========================================================================
const secretKey = 'gsk_test_1234567890abcdef_key';
const encryptedKey = encrypt(secretKey);
assert.notStrictEqual(encryptedKey, secretKey);
assert.strictEqual(encryptedKey.includes(secretKey), false);
assert.strictEqual(encryptedKey.split(':').length, 3); // iv:tag:encrypted
const decryptedKey = decrypt(encryptedKey);
assert.strictEqual(decryptedKey, secretKey);
console.log('✔ Test 1 passed: AES-256-GCM encryption & decryption at rest verified');

// =========================================================================
// Test 2: Password Hashing with Salt & Constant-Time Verification
// =========================================================================
const plainPassword = 'SuperSecretUserPassword123!';
const hashed = hashPassword(plainPassword);
assert.notStrictEqual(hashed.hash, plainPassword);
assert.strictEqual(verifyPassword(plainPassword, hashed.salt, hashed.hash), true);
assert.strictEqual(verifyPassword('WrongPassword!', hashed.salt, hashed.hash), false);
console.log('✔ Test 2 passed: Secure password hashing with salt verified');

// =========================================================================
// Test 3: Multi-Tenant Database Isolation: User A vs User B
// =========================================================================
const existingA = db.getUserByUsername('alice_test');
if (existingA) db.deleteUser(existingA.id);
const existingB = db.getUserByUsername('bob_test');
if (existingB) db.deleteUser(existingB.id);

const userA = db.createUser('alice_test', 'AlicePass123!', 'user', {
  ownerNumber: '923001111111',
  systemPrompt: 'You are Alice Assistant.'
});
const userB = db.createUser('bob_test', 'BobPass123!', 'user', {
  ownerNumber: '923002222222',
  systemPrompt: 'You are Bob Assistant.'
});

assert.notStrictEqual(userA.id, userB.id);

// Add conversations for Alice
db.addMessage(userA.id, 'chat_123@s.whatsapp.net', 'user', 'Hello Alice Bot', '923001111111@s.whatsapp.net', true);
db.addMessage(userA.id, 'chat_123@s.whatsapp.net', 'assistant', 'Hello Alice! I am your bot.', null, false);

// Verify Bob cannot see Alice's conversations
const aliceHistory = db.getConversationHistory(userA.id, 'chat_123@s.whatsapp.net');
const bobHistory = db.getConversationHistory(userB.id, 'chat_123@s.whatsapp.net');
assert.strictEqual(aliceHistory.length, 2);
assert.strictEqual(bobHistory.length, 0);
console.log('✔ Test 3 passed: User A and User B conversation history is strictly isolated');

// =========================================================================
// Test 4: Multi-Tenant System Prompt & Owner Number Isolation
// =========================================================================
assert.strictEqual(db.getSystemPrompt(userA.id), 'You are Alice Assistant.');
assert.strictEqual(db.getSystemPrompt(userB.id), 'You are Bob Assistant.');
assert.strictEqual(db.getOwnerNumber(userA.id), '923001111111');
assert.strictEqual(db.getOwnerNumber(userB.id), '923002222222');
console.log('✔ Test 4 passed: Tenant-specific system prompts and owner numbers isolated');

// =========================================================================
// Test 5: Multi-Tenant BYOK Encrypted Keys Isolation
// =========================================================================
db.setUserApiKeys(userA.id, { groqKeys: ['gsk_alice_key_1111111111'] });
db.setUserApiKeys(userB.id, { groqKeys: ['gsk_bob_key_2222222222'] });

const aliceKeys = db.getUserApiKeys(userA.id);
const bobKeys = db.getUserApiKeys(userB.id);
assert.strictEqual(aliceKeys.groqKeys[0], 'gsk_alice_key_1111111111');
assert.strictEqual(bobKeys.groqKeys[0], 'gsk_bob_key_2222222222');

// Verify stored data in JSON is encrypted (never plaintext)
assert.notStrictEqual(db.data.user_api_keys[userA.id].groqKeysEncrypted[0], 'gsk_alice_key_1111111111');
assert.strictEqual(db.data.user_api_keys[userA.id].groqKeysEncrypted[0].includes('gsk_alice_key'), false);

// Verify masked keys for safe UI presentation
const maskedAlice = db.getMaskedUserApiKeys(userA.id);
assert.strictEqual(maskedAlice.groqKeysMasked[0], 'gsk_al...1111');
console.log('✔ Test 5 passed: BYOK keys encrypted at rest and strictly isolated per user');

// =========================================================================
// Test 6: Multi-Tenant WhatsApp Bot Sessions & Dedup Isolation
// =========================================================================
const sessionA = sessionManager.getSession(userA.id);
const sessionB = sessionManager.getSession(userB.id);

assert.notStrictEqual(sessionA, sessionB);
assert.strictEqual(sessionA.userId, userA.id);
assert.strictEqual(sessionB.userId, userB.id);
assert.notStrictEqual(sessionA.sessionDir, sessionB.sessionDir);

// Verify message deduplication sets are separate
sessionA.processedInboundMsgIds.add('MSG_ALICE_001');
assert.strictEqual(sessionA.processedInboundMsgIds.has('MSG_ALICE_001'), true);
assert.strictEqual(sessionB.processedInboundMsgIds.has('MSG_ALICE_001'), false);
console.log('✔ Test 6 passed: UserBotSession instances & message deduplication sets are isolated');

// =========================================================================
// Test 7: Multi-Tenant Anti-Ban Rate Limiting Isolation
// =========================================================================
const targetChat = 'group_chat_shared@g.us';
for (let i = 0; i < config.rateLimitMaxPerMinute; i++) {
  sessionA.antiBan.recordReply(targetChat);
}
// Session A should now be rate limited
assert.strictEqual(sessionA.antiBan.checkRateLimit(targetChat), false);
// Session B MUST NOT be rate limited for the same chat
assert.strictEqual(sessionB.antiBan.checkRateLimit(targetChat), true);
console.log('✔ Test 7 passed: Anti-ban rate limiting for User A does not affect User B');

// =========================================================================
// Test 8: Tenant Owner Commands Verification
// =========================================================================
const aliceOwnerJid = '923001111111@s.whatsapp.net';
const bobOwnerJid = '923002222222@s.whatsapp.net';

assert.strictEqual(adminCommands.isOwner(aliceOwnerJid, false, userA.id), true);
assert.strictEqual(adminCommands.isOwner(bobOwnerJid, false, userA.id), false);
assert.strictEqual(adminCommands.isOwner(bobOwnerJid, false, userB.id), true);

const statusAlice = await adminCommands.handleCommand('/status', aliceOwnerJid, false, userA.id, sessionA.aiProvider);
assert.ok(statusAlice.includes('Mark Zuckerberg Assistant Status'));
const deniedBob = await adminCommands.handleCommand('/status', bobOwnerJid, false, userA.id, sessionA.aiProvider);
assert.ok(deniedBob.includes('ACCESS DENIED'));
console.log('✔ Test 8 passed: WhatsApp admin commands are strictly authorized per tenant');

// =========================================================================
// Test 9: Web Session Authentication & Server Tenancy Enforcement
// =========================================================================
const tokenAlice = db.createWebSession(userA.id);
const tokenBob = db.createWebSession(userB.id);

const authAlice = db.getWebSession(tokenAlice);
const authBob = db.getWebSession(tokenBob);
assert.strictEqual(authAlice.id, userA.id);
assert.strictEqual(authBob.id, userB.id);

// Authenticate via credentials
const authed = db.authenticate('alice_test', 'AlicePass123!');
assert.ok(authed);
assert.strictEqual(authed.id, userA.id);
const failedAuth = db.authenticate('alice_test', 'WrongPassword');
assert.strictEqual(failedAuth, null);
console.log('✔ Test 9 passed: Web session creation, authentication & tokens verified');

// =========================================================================
// Test 10: Simple Greeting ("Hi") -> Fast-path Routes to simple
// =========================================================================
const routeHi = await aiProvider.routePrompt('Hi');
assert.strictEqual(routeHi.route, 'simple');
const modelHi = aiProvider.selectModel(routeHi.route, 'groq');
assert.strictEqual(modelHi.model, 'openai/gpt-oss-20b');
assert.strictEqual(modelHi.isReasoning, false);
console.log('✔ Test 10 passed: "Hi" routes to simple & Groq GPT-OSS 20B');

// =========================================================================
// Test 11: Casual Conversation ("How are you?") -> Routes to simple
// =========================================================================
const routeHowAreYou = await aiProvider.routePrompt('How are you?');
assert.strictEqual(routeHowAreYou.route, 'simple');
const modelHowAreYou = aiProvider.selectModel(routeHowAreYou.route, 'groq');
assert.strictEqual(modelHowAreYou.isReasoning, false);
console.log('✔ Test 11 passed: "How are you?" routes to simple');

// =========================================================================
// Test 12: Router Heuristic Fallback & Complex Detection
// =========================================================================
const brokenRouteShort = await aiProvider.routePrompt('', []);
assert.strictEqual(brokenRouteShort.route, 'simple');
const heuristicSimple = aiProvider.applyHeuristicRoute('hello');
assert.strictEqual(heuristicSimple.route, 'simple');
const heuristicComplex = aiProvider.applyHeuristicRoute('a'.repeat(250) + '```const x = 1;```');
assert.strictEqual(heuristicComplex.route, 'reasoning');
console.log('✔ Test 12 passed: Router heuristic safely classifies simple vs complex without crashing');

// =========================================================================
// Test 13: Clean Response Strips <think> Tags
// =========================================================================
const leakedThinkPayload = `<think>
User asked about Gohar.
buay is likely bolo.
Output: Ji, batayein. Gohar bhai ko kya kehna hai?
</think>
Ji, batayein. Gohar bhai ko kya kehna hai?`;
const strippedThink = aiProvider.cleanResponse(leakedThinkPayload);
assert.strictEqual(strippedThink, 'Ji, batayein. Gohar bhai ko kya kehna hai?');
assert.strictEqual(strippedThink.includes('<think>'), false);
console.log('✔ Test 13 passed: Artificial <think> tags are stripped completely');

// =========================================================================
// Test 14: Trigger Rules (@mark, @number, quote to bot)
// =========================================================================
const mockBotJid = '92323852260@s.whatsapp.net';
const mockBotLid = '107559570657320@lid';

const msgWithMark = { message: { conversation: 'Hey @mark how does this work?' } };
assert.strictEqual(permissionChecker.isBotMentionedInGroup(msgWithMark, mockBotJid, mockBotLid, 'Hey @mark how does this work?'), true);

const msgWithNum = { message: { conversation: 'Hey @92323852260 check this' } };
assert.strictEqual(permissionChecker.isBotMentionedInGroup(msgWithNum, mockBotJid, mockBotLid, 'Hey @92323852260 check this'), true);

const msgQuoteBot = {
  message: {
    extendedTextMessage: {
      text: 'What do you mean?',
      contextInfo: { participant: mockBotJid }
    }
  }
};
assert.strictEqual(permissionChecker.isBotMentionedInGroup(msgQuoteBot, mockBotJid, mockBotLid, 'What do you mean?'), true);
console.log('✔ Test 14 passed: Group trigger rules (@mark, @number, quote to bot) verified');

// =========================================================================
// Test 15: Media Type Detection & Multimodal Packaging
// =========================================================================
assert.strictEqual(permissionChecker.detectMediaType({ imageMessage: {} }), 'image');
assert.strictEqual(permissionChecker.detectMediaType({ audioMessage: {} }), 'audio');
assert.strictEqual(permissionChecker.detectMediaType({ videoMessage: {} }), 'video');
assert.strictEqual(permissionChecker.detectMediaType({ conversation: 'hello' }), 'text');

const preparedMultimodal = aiProvider.prepareMessages([], 'Analyze photo', false, {
  mediaBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  mediaMimeType: 'image/png'
});
assert.strictEqual(Array.isArray(preparedMultimodal[1].content), true);
assert.strictEqual(preparedMultimodal[1].content[1].type, 'image_url');
console.log('✔ Test 15 passed: Media type detection and multimodal payload packaging verified');

// =========================================================================
// Test 16: Express Server HTTP Multi-Tenancy & Authorization Enforcement
// =========================================================================
const app = createServer();
const server = await new Promise(resolve => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  // 16a. Unauthenticated access to /api/status -> 401
  const unauthRes = await fetch(`${baseUrl}/api/status`);
  assert.strictEqual(unauthRes.status, 401);

  // 16b. User A login
  const loginResA = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice_test', password: 'AlicePass123!' })
  });
  assert.strictEqual(loginResA.status, 200);
  const loginDataA = await loginResA.json();
  const tokenA = loginDataA.token;
  assert.ok(tokenA);

  // 16c. User A accesses /api/status -> returns User A's session
  const statusResA = await fetch(`${baseUrl}/api/status`, {
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  assert.strictEqual(statusResA.status, 200);
  const statusDataA = await statusResA.json();
  assert.strictEqual(statusDataA.userId, userA.id);

  // 16d. User A attempts to bypass tenancy by passing ?userId=userB -> Still receives User A's session
  const spoofRes = await fetch(`${baseUrl}/api/status?userId=${userB.id}`, {
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  assert.strictEqual(spoofRes.status, 200);
  const spoofData = await spoofRes.json();
  assert.strictEqual(spoofData.userId, userA.id);

  // 16e. User A attempts admin access -> 403 Forbidden
  const adminResForA = await fetch(`${baseUrl}/api/admin/users`, {
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  assert.strictEqual(adminResForA.status, 403);

  // 16f. Admin user creates and verifies admin access
  const adminUser = Object.values(db.data.users).find(u => u.role === 'admin');
  assert.ok(adminUser);
  const adminToken = db.createWebSession(adminUser.id);

  const adminListRes = await fetch(`${baseUrl}/api/admin/users`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  assert.strictEqual(adminListRes.status, 200);
  const adminListData = await adminListRes.json();
  assert.ok(Array.isArray(adminListData.users));
  assert.ok(adminListData.users.some(u => u.username === 'alice_test'));

  console.log('✔ Test 16 passed: HTTP Multi-tenancy & Admin Role Authorization strictly enforced');

  // =========================================================================
  // Test 17: Hardened HMAC-SHA256 Internal Protocol & Replay Protection
  // =========================================================================
  const internalSecret = config.internalApiKey;

  // 17a. Missing internal auth headers -> 401
  const noHeaderRes = await fetch(`${baseUrl}/internal/health`);
  assert.strictEqual(noHeaderRes.status, 401);

  // 17b. Valid signed request to /internal/health -> 200
  const validHeaders = createSignedHeaders(internalSecret, 'GET', '/internal/health');
  const healthRes = await fetch(`${baseUrl}/internal/health`, { headers: validHeaders });
  assert.strictEqual(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.strictEqual(healthData.status, 'ok');

  // 17c. Replay Attack with same nonce -> 401
  const replayRes = await fetch(`${baseUrl}/internal/health`, { headers: validHeaders });
  assert.strictEqual(replayRes.status, 401);

  // 17d. Expired timestamp (> 5 minutes old) -> 401
  const expiredTimestamp = (Date.now() - 10 * 60 * 1000).toString();
  const expiredNonce = 'expired_nonce_12345';
  const expiredSig = createSignature(internalSecret, 'GET', '/internal/health', expiredTimestamp, expiredNonce, '');
  const expiredHeaders = {
    'x-internal-key': internalSecret,
    'x-internal-timestamp': expiredTimestamp,
    'x-internal-nonce': expiredNonce,
    'x-internal-signature': expiredSig
  };
  const expiredRes = await fetch(`${baseUrl}/internal/health`, { headers: expiredHeaders });
  assert.strictEqual(expiredRes.status, 401);

  // 17e. Signed settings synchronization to runtime in memory
  const syncBody = {
    provider: 'groq',
    ownerNumber: '923009999999',
    systemPrompt: 'Internal synchronized prompt',
    groqKeys: ['gsk_synced_key_99999']
  };
  const syncHeaders = createSignedHeaders(internalSecret, 'POST', `/internal/sync-settings/${userA.id}`, syncBody);
  const syncRes = await fetch(`${baseUrl}/internal/sync-settings/${userA.id}`, {
    method: 'POST',
    headers: syncHeaders,
    body: JSON.stringify(syncBody)
  });
  assert.strictEqual(syncRes.status, 200);

  // Verify UserBotSession runtime in-memory update
  const sessionCheckA = sessionManager.getSession(userA.id);
  assert.strictEqual(sessionCheckA.aiProvider.getActiveProvider(), 'groq');
  assert.strictEqual(sessionCheckA.aiProvider.groqKeys[0], 'gsk_synced_key_99999');
  assert.strictEqual(sessionCheckA.aiProvider.getSystemPrompt(), 'Internal synchronized prompt');

  console.log('✔ Test 17 passed: HMAC-SHA256 internal protocol, replay attack defense & in-memory sync verified');
} finally {
  server.close();
}

// =========================================================================
// Cleanup test users
// =========================================================================
db.deleteUser(userA.id);
db.deleteUser(userB.id);

console.log('\n🎉 ALL MULTI-TENANT ISOLATION, BYOK, HMAC PROTOCOL & AI RELIABILITY TESTS PASSED PERFECTLY! 🎉\n');

