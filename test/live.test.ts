// Against a real Pipedrive test company, through the gateway as a host uses it: reads, then a short round of
// changes that can all be undone in Pipedrive. Runs only when PIPEDRIVE_TEST_API_TOKEN is set (the CI job "live" sets
// it from the repository secret of the same name); otherwise every test is skipped with a notice.
//
// The token must belong to a user in a company that holds only made-up data (a trial company is fine). Each run
// creates one organization, one person, one deal (marked lost at the end), one activity (done) and one note, all
// named "letmcp systemtest" with the date. Nothing is deleted: the client has no DELETE.
//
// Only true or false is asserted, never a value from the company, so no data reaches the CI log.
import { describe, expect, it } from 'vitest';
import { createPipedriveGateway, type GatewayJsonObject } from '../src/gateway.js';

const token = process.env.PIPEDRIVE_TEST_API_TOKEN?.trim() ?? '';

if (!token) {
  // One line in the test output, so a skipped run is visible.
  process.stdout.write('Pipedrive live test skipped: PIPEDRIVE_TEST_API_TOKEN is not set.\n');
}

describe.skipIf(!token)('live Pipedrive test company', () => {
  const gw = createPipedriveGateway({ apiToken: token || 'pppp-uuuu-nnnn-ssss-0', policy: { enableWrites: true } });
  const label = `letmcp systemtest ${new Date().toISOString().slice(0, 10)}`;
  const run = async (tool: string, input: GatewayJsonObject = {}) => {
    const result = await gw.callTool(tool, input, { caller: 'live-test' });
    // The tool name only: the answer is the company's data and stays out of the log.
    expect(result.isError, tool).toBeUndefined();
    return result.structuredContent as Record<string, unknown>;
  };
  const id = (value: unknown) => {
    expect(typeof value === 'number' && value > 0).toBe(true);
    return value as number;
  };

  it('reads: connection, users, pipelines, deals, persons, organizations, activities and notes', { timeout: 60_000 }, async () => {
    expect((await run('check_connection')).connected).toBe(true);
    expect(Array.isArray((await run('list_users')).users)).toBe(true);
    expect(Array.isArray((await run('list_pipelines')).pipelines)).toBe(true);
    for (const tool of ['search_deals', 'search_persons', 'search_organizations', 'list_activities', 'list_notes']) {
      expect(Array.isArray((await run(tool, { limit: 5 })).results), tool).toBe(true);
    }
  });

  it('changes: creates, updates and moves records, and reads them back', { timeout: 120_000 }, async () => {
    const org = await run('create_organization', { name: label });
    const orgId = id(org.id);
    expect((await run('update_organization', { orgId, address: 'Eksempelvej 1, 8000 Aarhus C' })).updated).toBe(true);

    const person = await run('create_person', { name: label, email: 'systemtest@example.com', orgId });
    const personId = id(person.id);
    expect((await run('update_person', { personId, jobTitle: 'Testperson' })).updated).toBe(true);

    const deal = await run('create_deal', { title: label, value: 1, currency: 'DKK', personId, orgId });
    const dealId = id(deal.id);
    const record = deal.record as { pipeline_id?: number; stage_id?: number };
    const pipelines = (await run('list_pipelines')).pipelines as Array<{ id: number; stages: Array<{ id: number }> }>;
    const other = pipelines.find(entry => entry.id === record.pipeline_id)?.stages.find(entry => entry.id !== record.stage_id);
    if (other) {
      const moved = await run('move_deal', { dealId, stageId: other.id });
      expect((moved.record as { stage_id?: number }).stage_id === other.id).toBe(true);
    }
    expect((await run('get_deal', { dealId })).id === dealId).toBe(true);

    const activity = await run('create_activity', { subject: label, type: 'call', dueDate: new Date().toISOString().slice(0, 10), dealId, personId });
    const activityId = id(activity.id);
    const done = await run('update_activity', { activityId, done: true });
    expect((done.record as { done?: boolean }).done).toBe(true);

    const note = await run('add_note', { on: 'deal', recordId: dealId, content: label });
    const noteId = id(note.noteId);
    expect((await run('update_note', { noteId, content: `${label}, rettet` })).updated).toBe(true);
    const notes = (await run('list_notes', { dealId })).results as Array<{ id: number }>;
    expect(notes.some(entry => entry.id === noteId)).toBe(true);

    // Out of the open pipeline again: marked lost, which a user can undo in Pipedrive.
    const lost = await run('update_deal', { dealId, status: 'lost', lostReason: 'systemtest' });
    expect((lost.record as { status?: string }).status).toBe('lost');
  });
});
