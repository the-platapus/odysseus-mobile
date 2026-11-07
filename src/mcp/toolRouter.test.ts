/// <reference types="node" />
// Runs with `npm test` (bun). Only imports this repo's own files, so CI needs no install.
// The prompts and the "remote" tools below are hand-written, so these tests catch regressions;
// they don't say how often the router is right on what people really type.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatMessage, buildAgentSystemPrompt, runAgentTurn } from './agentLoop';
import { FsAdapter, createFilesystemServer } from './builtin/filesystem';
import { createMemoryServer } from './builtin/memory';
import { McpManager, OpenAITool } from './manager';
import { textResult } from './protocol';
import { McpServer, ServerTool } from './server';
import { TOOL_TOKEN_BUDGET, pickTools, routeTools, toolTokens } from './toolRouter';
import { InProcessTransport } from './transports';

const tool = (name: string, description: string, extra: Partial<ServerTool> = {}): ServerTool => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What to look for' } } },
  handler: async () => textResult('ok'),
  ...extra,
});

const REMOTE: Record<string, ServerTool[]> = {
  calendar: [
    tool('list_events', 'List events on the calendar for a date range: schedule, agenda, meetings and appointments.'),
    tool('add_event', 'Add an event, meeting or appointment to the calendar.'),
  ],
  contacts: [tool('search_contacts', "Find a person in the address book and get their phone number or email address.")],
  web: [
    tool('web_search', 'Search the web for current information, news, facts and prices.'),
    tool('fetch_page', 'Download a web page by URL and return its readable text.'),
  ],
  weather: [tool('get_forecast', 'Get the weather forecast for a city: temperature, rain and wind.')],
  reminders: [tool('add_reminder', 'Set a reminder that shows a notification at a given time.')],
  device: [
    tool('device_status', 'Get the battery level, charging state, storage and network connection of the device.'),
    tool('get_location', 'Get the current location of the device: city, address and coordinates.'),
  ],
  issues: [
    tool('list_issues', 'List open issues in a code repository.'),
    tool('create_issue', 'Open a new issue in a code repository with a title and body.'),
  ],
  maps: [tool('get_directions', 'Get driving, walking or transit directions between two places.')],
  music: [tool('play_track', 'Play a song, album or playlist.')],
  finance: [tool('exchange_rate', 'Convert an amount of money between two currencies at the latest exchange rate.')],
};

const memoryStore = { load: async () => [], save: async () => {} };

async function connect(manager: McpManager, id: string, builtin: boolean, server: () => McpServer) {
  await manager.connectServer({ id, name: id, builtin, createTransport: () => new InProcessTransport(server()) });
}

async function managerWith(remote: Record<string, ServerTool[]>) {
  const manager = new McpManager();
  await connect(manager, 'files', true, () => createFilesystemServer({ describeRoot: () => 'workspace' } as FsAdapter));
  await connect(manager, 'memory', true, () => createMemoryServer(memoryStore));
  for (const [id, tools] of Object.entries(remote)) {
    await connect(manager, id, false, () => new McpServer({ info: { name: id, version: '1' }, instructions: `Notes from ${id}.`, tools }));
  }
  return manager;
}

const builtinsOnly = await managerWith({});
const manager = await managerWith(REMOTE);

const say = (content: string): ChatMessage[] => [{ role: 'user', content }];
const shortNames = (tools: OpenAITool[]) => tools.map((t) => t.function.name.split('__')[2]);
const called = (name: string, id = 'call00001'): ChatMessage[] => [
  { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] },
  { role: 'tool', tool_call_id: id, name, content: 'ok' },
  { role: 'assistant', content: 'Done.' },
];

const GOLDEN: [string, string][] = [
  // Built-ins: these have keywords.
  ["show me what's in the documents folder", 'list_directory'],
  ['what files are in my workspace', 'list_directory'],
  ['look at todo.md', 'read_file'],
  ['open notes.txt', 'read_file'],
  ['save this as ideas.txt', 'write_file'],
  ['create a file called shopping.md', 'write_file'],
  ['rename the title in draft.md to Hello', 'edit_file'],
  ['make a folder called receipts', 'create_directory'],
  ['get rid of draft.md', 'delete_path'],
  ['delete old.txt', 'delete_path'],
  ['which file talks about taxes', 'search_files'],
  ['find the file that mentions invoices', 'search_files'],
  ['my name is abdul, keep that in mind', 'manage_memory'],
  ['forget what i said about my job', 'manage_memory'],
  ['remember that i prefer short answers', 'manage_memory'],
  ['what do you remember about me', 'manage_memory'],
  // Remote: only their names and descriptions to go on.
  ["what's on my calendar tomorrow", 'list_events'],
  ['do i have any meetings on friday', 'list_events'],
  ['add a dentist appointment next tuesday at 3pm', 'add_event'],
  ["find ali's email address", 'search_contacts'],
  ['search the web for the latest iphone news', 'web_search'],
  ['read this page https://example.com/post', 'fetch_page'],
  ['will it rain in lahore this weekend', 'get_forecast'],
  ['set a reminder for my pills tonight', 'add_reminder'],
  ['how much battery do i have left', 'device_status'],
  ['what city am i in', 'get_location'],
  ['list the open issues', 'list_issues'],
  ['open a new issue about the crash', 'create_issue'],
  ['directions to the airport', 'get_directions'],
  ['play some music', 'play_track'],
  ['convert 100 dollars to rupees at the exchange rate', 'exchange_rate'],
];

const CHIT_CHAT = ['hi', 'thanks that was helpful', 'tell me a joke', 'what is recursion', 'explain how vaccines work', 'give me a recipe for biryani'];

test('the built-ins alone fit, so nothing is routed', () => {
  const all = builtinsOnly.getOpenAITools();
  assert.equal(all.length, 8);
  assert.deepEqual(routeTools(builtinsOnly, say('tell me a joke')), all);
});

test('the fixture is over budget, so everything below is routed', () => {
  const all = manager.getOpenAITools();
  assert.ok(routeTools(manager, say('tell me a joke')).length < all.length);
});

for (const [prompt, expected] of GOLDEN) {
  test(`"${prompt}" offers ${expected}`, () => {
    const offered = routeTools(manager, say(prompt));
    assert.ok(shortNames(offered).includes(expected), `offered: ${shortNames(offered).join(', ')}`);
    assert.ok(toolTokens(offered) < TOOL_TOKEN_BUDGET + 1, `about ${toolTokens(offered)} tokens`);
  });
}

for (const prompt of CHIT_CHAT) {
  test(`"${prompt}" falls back to the built-ins`, () => {
    assert.deepEqual(routeTools(manager, say(prompt)), builtinsOnly.getOpenAITools());
  });
}

test('a message in another script falls back to the built-ins', () => {
  assert.deepEqual(routeTools(manager, say('آج موسم کیسا ہے')), builtinsOnly.getOpenAITools());
});

test('leftover budget goes to the built-ins, so a word the router missed costs nothing', () => {
  const offered = shortNames(routeTools(manager, say('wipe draft.md and check my calendar')));
  assert.ok(offered.includes('list_events'));
  assert.ok(offered.includes('delete_path'), `offered: ${offered.join(', ')}`);
});

test("a big server still matches on a word all of its tools share", async () => {
  const kinds = ['now', 'hourly', 'daily', 'alerts', 'radar', 'wind', 'tide', 'snow', 'storm', 'humidity', 'pressure', 'history'];
  const big = await managerWith({ weather: kinds.map((kind) => tool(`weather_${kind}`, 'Weather data for a location.')) });
  assert.ok(shortNames(routeTools(big, say("what's the weather"))).some((name) => name.startsWith('weather_')));
});

test('a follow-up keeps the tools of the previous turns', () => {
  const name = 'mcp__calendar__add_event';
  const messages = [...say('add lunch on monday'), ...called(name), ...say('and the same on friday please')];
  assert.ok(routeTools(manager, messages).some((t) => t.function.name === name));
});

test('tools from more than two turns ago are dropped', () => {
  const name = 'mcp__calendar__add_event';
  const messages = [
    ...say('add lunch on monday'), ...called(name),
    ...say('thanks'), { role: 'assistant', content: 'Any time.' } as ChatMessage,
    ...say('nice'), { role: 'assistant', content: ':)' } as ChatMessage,
    ...say('tell me a joke'),
  ];
  assert.ok(!routeTools(manager, messages).some((t) => t.function.name === name));
});

test('the offered tools keep the manager order, whatever their scores', () => {
  const order = manager.getOpenAITools().map((t) => t.function.name);
  const offered = routeTools(manager, say('find the file about the meeting in my calendar')).map((t) => t.function.name);
  assert.ok(offered.length > 1);
  assert.deepEqual(offered, order.filter((name) => offered.includes(name)));
});

test('a disabled tool is not offered, even when it matches or was just used', () => {
  const disabled = { calendar: ['list_events'] };
  const name = 'mcp__calendar__list_events';
  const messages = [...say('my meetings'), ...called(name), ...say("what's on my calendar tomorrow")];
  assert.ok(!routeTools(manager, messages, disabled).some((t) => t.function.name === name));
});

test('keywords are never sent to the model', () => {
  assert.ok(!JSON.stringify(manager.getOpenAITools()).includes('keywords'));
  assert.ok(!JSON.stringify(manager.getOpenAITools()).includes('mkdir'));
});

test('keywords from a remote server are ignored', async () => {
  const stuffed = await managerWith({ ...REMOTE, stuffed: [tool('sell', 'Buy things.', { keywords: 'joke tell hi' })] });
  assert.ok(!shortNames(routeTools(stuffed, say('tell me a joke'))).includes('sell'));
});

test('a tool too big for the budget is skipped, and smaller matches still fit', () => {
  const schema = (name: string, description: string): OpenAITool => ({
    type: 'function',
    function: { name, description, parameters: {} },
  });
  const huge = schema('mcp__big__weather_report', `Weather report. ${'x'.repeat(TOOL_TOKEN_BUDGET * 5)}`);
  const small = schema('mcp__small__weather_now', 'Weather now.');
  const hints = () => ({ builtin: false });
  assert.deepEqual(pickTools([huge, small], say('weather'), hints), [small]);
});

test('every round of a turn offers the same tools, and the last one none', async () => {
  const offered = routeTools(manager, say('do i have any meetings on friday'));
  const seen: (OpenAITool[] | undefined)[] = [];
  let n = 0;
  await runAgentTurn({
    complete: async ({ tools }) => {
      seen.push(tools);
      n++;
      return { content: '', interrupted: false, toolCalls: [{ id: `call${n}`, function: { name: 'mcp__calendar__list_events', arguments: `{"query":"${n}"}` } }] };
    },
    manager,
    messages: say('do i have any meetings on friday'),
    tools: offered,
    maxRounds: 2,
    onEvent: () => {},
  });
  assert.deepEqual(seen, [offered, offered, undefined]);
});

test('the system prompt only carries instructions from servers with offered tools', () => {
  const offered = routeTools(manager, say("what's on my calendar tomorrow"));
  const prompt = buildAgentSystemPrompt('You are helpful.', manager, offered);
  assert.ok(prompt.includes('Notes from calendar.'));
  assert.ok(!prompt.includes('Notes from music.'));
});
