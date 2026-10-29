import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const bundledRoot = new URL('../../../content/agent-plugins/', import.meta.url);
const topicPlugins = ['seo', 'email-lifecycle'];
const playbookSkills = ['ad-copy-variants', 'strategy-and-brief', 'analytics-attribution-basics', 'landing-page-cro', 'creative-fatigue-review', 'creative-test-plan'];
const commonRevision = '7868cb9251fad80a73d26e488a5ad5f6c4a9f335';
// Content fixtures only; Node and Vitest callbacks retain their native signatures.
const read = ({ path }: { path: string }): string => readFileSync(new URL(path, bundledRoot), 'utf8');

it.each(topicPlugins)('keeps %s provenance reachable inside the installed skills tree', name => {
  const skillPath = `${name}/skills/${name}/SKILL.md`;
  const link = read({ path: skillPath }).match(/\[[^\]]+\]\(([^) ]*PROVENANCE\.md)\)/);
  expect(link, 'the skill must link to its retained provenance').not.toBeNull();
  const target = new URL(link![1]!, new URL(skillPath, bundledRoot));
  expect(target.href).toBe(new URL(`${name}/skills/${name}/PROVENANCE.md`, bundledRoot).href);
  const provenance = readFileSync(target, 'utf8');
  expect(provenance).toContain('## Immutable upstream sources');
  expect(provenance).toContain('bundled Add-ons catalog');
  expect(provenance).toContain('disabled by default');
  expect(provenance).not.toContain('Catalog inclusion and activation are not');
  expect(existsSync(new URL(`${name}/PROVENANCE.md`, bundledRoot))).toBe(false);
});

it.each(topicPlugins)('retains upstream and OM attribution under the %s MIT license', name => {
  const license = read({ path: `${name}/LICENSE` });
  const upstream = name === 'seo' ? 'agricidaniel' : 'jacquescorbytuech';
  expect(license).toContain(`Copyright (c) 2026 ${upstream}`);
  expect(license).toContain('Copyright (c) 2026 AINSEP');
  expect(license).toContain('Permission is hereby granted, free of charge');
  expect(license).toContain('The above copyright notice and this permission notice');
  expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  expect(JSON.parse(read({ path: `${name}/plugin.json` }))).toMatchObject({ license: 'MIT' });
});

it('acknowledges adapted MIT material in the playbook NOTICE', () => {
  const notice = read({ path: 'om-playbook/NOTICE' });
  expect(notice).toContain('MIT-licensed material adapted from coreyhaines31/marketingskills');
  expect(notice).toContain('skills/*/PROVENANCE.md');
  expect(notice).not.toContain('No vendor source copied');
});

it.each(playbookSkills)('retains %s source links and the upstream MIT notice', name => {
  const provenance = read({ path: `om-playbook/skills/${name}/PROVENANCE.md` });
  expect(read({ path: `om-playbook/skills/${name}/SKILL.md` })).toContain('(PROVENANCE.md)');
  expect(provenance).toMatch(/https:\/\/github\.com\/coreyhaines31\/marketingskills\/blob\/[a-f0-9]{40}\//);
  expect(provenance).toContain('Copyright (c) 2025 Corey Haines');
  expect(provenance).toContain('Permission is hereby granted, free of charge');
  expect(provenance).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
});

it('keeps all six marketing adaptations on one source revision', () => {
  for (const name of playbookSkills) {
    const provenance = read({ path: `om-playbook/skills/${name}/PROVENANCE.md` });
    const links = provenance.matchAll(/marketingskills\/blob\/([a-f0-9]{40})\//g);
    const revisions = [...links].map(match => match[1]);
    expect(provenance).toContain(`\`${commonRevision}\``);
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    expect(new Set(revisions)).toEqual(new Set([commonRevision]));
  }
  expect(read({ path: 'om-playbook/skills/ad-copy-variants/PROVENANCE.md' })).toContain(
    `https://raw.githubusercontent.com/coreyhaines31/marketingskills/${commonRevision}/LICENSE`,
  );
});

it.each([
  {
    placement: 'Facebook feed image', guide: 'facebook-feed',
    fields: 'Rec: primary text 50–150; headline 27',
    caveats: 'Description guidance and character maximums: Unknown.',
    guidance: 'Recommended primary text: 50–150 characters; headline: 27 characters.',
  },
  {
    placement: 'Instagram feed image', guide: 'instagram-feed',
    fields: 'Rec: primary text 125; headline 40',
    caveats: 'Max: 30 hashtags. Description guidance and character maximums: Unknown.',
    guidance: 'Recommended primary text: 125 characters; headline: 40 characters. Maximum number of hashtags: 30.',
  },
])('retains cited recommendations and unresolved character maximums for $placement', ({ placement, guide, fields, caveats, guidance }) => {
  const skill = read({ path: 'om-playbook/skills/ad-copy-variants/SKILL.md' });
  const limits = read({ path: 'om-playbook/skills/ad-copy-variants/references/platform-limits.md' });
  expect(skill).toContain(`| ${placement} | ${fields} | ${caveats} |`);
  expect(limits).toContain(`https://www.facebook.com/business/ads-guide/update/image/${guide}`);
  expect(limits).toContain(guidance);
});

it('attributes Meta guidance to dated review evidence without stale access claims', () => {
  const skill = read({ path: 'om-playbook/skills/ad-copy-variants/SKILL.md' });
  const limits = read({ path: 'om-playbook/skills/ad-copy-variants/references/platform-limits.md' });
  expect(limits).toContain('Meta guidance verified by the **2026-10-26 re-review**');
  expect(limits).toContain('Description guidance and character maximums remain Unknown for both placements.');
  expect(skill + limits).not.toMatch(/login-blocked|redirect(?:ed)? to login|recommendations remain unverified|recommendations remain unresolved/i);
});
