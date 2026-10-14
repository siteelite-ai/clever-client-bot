#!/usr/bin/env node

// Export the reviewed schema history for a separate, empty self-hosted test DB.
// This intentionally does not connect to any database or modify source SQL.
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceDir = join(repoRoot, 'supabase', 'migrations');
const HARDENING_MANIFEST = new Map([
  ['20261014182000_selfhost_limit_role_lookup.sql', '3cef4648aada44b486ee051e257ecc42ea41a890f7e5fb59495884b4a875efb8'],
  ['20261014183000_selfhost_revoke_client_table_grants.sql', 'e72f17c2f57cbb77b9931a3f04a5b2bcd9f0e480d4ab9287cf6db6f2d253e5c5'],
]);

// Reviewed filename/SHA-256 pairs. A source edit, addition, or deletion must
// trigger a fresh review instead of silently changing the deployed history.
const SOURCE_MANIFEST_TEXT = `
48f1464fa3129985a96eed75f5f1af05ed3d8fbfd703781b209edbf7bf9a7f74  20260205134112_42610e26-f07f-4e67-8c25-26594ae856b8.sql
fa33b3f10d2f4ed6d0c6f9e5d90dc8f19ed9d5648012b46175dd034357caa015  20260205141125_554889df-fc90-4e91-a79c-47ec1e08df64.sql
9c1f98c9cb49f15db47426c9b496ac99385fa61ddbed23fd05a99f4fb5b674da  20260206052858_08946db3-c42a-45fe-b7a1-a165fda8126f.sql
f4a3dbbd56f0f8dfe1bf22295f8ae84213d0c2b12f1aaf9e6f2643e240eaa0ff  20260206054525_2b2c2ca9-4192-40c1-b976-c83841c95a33.sql
82db6c832a493fb2e184d610a0f7bda384b934a64dbb39cadae95b052df5ef49  20260209084004_1abc37c9-2b0c-4d19-a692-fe68525e1343.sql
b72d4acbdf01779e08468af2aa2311658d7e4529e0a7676c66d4f9ae4002e802  20260211124030_deb99101-71cb-4348-a100-361ecc76632b.sql
869e0a7bfd0525cc6b3e8c02cf376dfa682bfe6f3d4fa3e146900d482dcb6df1  20260211143937_3d9ff103-cec4-4ae0-82df-9d4f81f25cbd.sql
5e9710891f4fbafb1b53608cf6e04bca6e6dd32709cebd32361b369bf725c2cc  20260218095324_84ac0b34-ffba-422e-b49c-86b53946b35f.sql
6feab006facc4632395caea4c0cae64264e36b831195ecc2ec963e75a5d4f308  20260219122902_52e04537-cfff-4d0c-9d4a-d5299571f37b.sql
270915b324f3870ee801180910cfb89ddcde4f75d5f7fe9a5e647d8e50187b97  20260225164358_b3bfa762-eccb-461d-aeab-cec0be995c2e.sql
e2c45af7a83106a5f86e8321fe2cef009531097e15e5b870a994fbedfe3ed143  20260302152518_c9fbaa86-26ee-43b1-a8fd-5adde090ec53.sql
78ec82f4e403370cf4fac970967827b09dce92a81346a1de9cdbab7eaf3b5250  20260304065741_c0e4649f-5ac0-488c-8f37-f995b2cdc859.sql
00a6d2107fbd406199351ec15a628bc67975ac4b4208378241602cc80de267c3  20260330105638_ef1cf495-fa14-44cd-a2ea-dcd44d87381a.sql
ebf29c57eecf91e11871664e59febe311ed0445d59bdfd7ec4835a469139b660  20260330105800_488dd643-c5b4-40d9-b11f-93e88bb10a74.sql
ea234695c550ba0893aa3793b4dbf9a7f3618eaecc223317fc146525390559d1  20260406125155_01577fc3-44c3-4074-a9c0-e36c988756b1.sql
96d67291f8a4556e20f9175d5578e4105f823e64b4f34accc0634633aac700a7  20260428143614_d384b067-6863-4c04-9f48-14b8f7c38920.sql
30896886ec68513337f320a2d7088b935d1d514db3fa0675f9460ff43d6aa20c  20260428162337_7500944f-b0a0-4f6d-adac-3438f8097e77.sql
f2b814d970e7bd584acb6a3385221ec938fe3f787823315de2dda73196982894  20260428174239_7710898d-2675-4e17-bb1c-664b1a3b36bf.sql
ec903aeeeda8146981239caaa5a7c45c4e07a0131e727f9ddffd7729cbc1d0e1  20260428184434_f2731990-d7fd-4e48-90c8-f064f9c36087.sql
889d2c2fb0234e5f0bd3416d2502e19b9fb75ee789758760e24c649f78a2c602  20260428184702_262d5ef7-e79b-4708-8ace-6e0fc0ab4ef1.sql
a5733d08635f0112d0b3ee3c910f845340d3d9cbc56ebd205f95d252f7e82a07  20260428211825_61f0dd3c-f23d-4f60-892d-4e441e5e770f.sql
6ba5ec9e8164f7c4afc1691803a4785eb916218c687a6a4a8bd423a0d0b0927e  20260430124408_9258b60e-0de7-47f2-9c16-b9b76f9f03ba.sql
79b986519a34bfd1f6fdeb66a004c7eaff6c7df7a5ba11e88cd05aa58e6cb9f6  20260430172328_cef67774-7343-41fb-84f9-7837e94a0242.sql
d26ed31616cfacf9c6c67ea674fb94ab5107ddb927c37d20d89ae8ff08d0c60e  20260430175146_22d18b74-d1fd-4219-81bf-b144b44817dc.sql
79b986519a34bfd1f6fdeb66a004c7eaff6c7df7a5ba11e88cd05aa58e6cb9f6  20260430202131_770128e5-f716-4cb8-894e-559e98dedb3e.sql
a72695906633801a1b8bbedcfc1afae57a9c1e9191edfd177e16bee46d965270  20260504080434_4a062df9-ebfe-449f-b384-1d6c67f5bec4.sql
54ad80e3feeb184e0aca49ed65c67e8caa526321379ab665c0d66254f109ca1f  20260504081206_ef3be98f-1d34-49d1-882c-47a33ef40b02.sql
ba2a2c95ca33ff3d648c0de30c0a1edca6d5227765a5d9db26c08faf2010b370  20260505131753_4b6437ff-631b-4698-b4d3-819be3720b2b.sql
fb739246a4e8e5010a65f49232bff436c43ecd3832208b3846604d93eb172cee  20260507081101_30c91ff9-9f7a-4048-b5bb-a3f62497ee17.sql
72ef08834df9ebe6d5fbaa5d36fc0a9c66429e4fb527466b1cfed24534990ba4  20260507083148_809b84b5-0059-4eaa-9984-d8490dc6cc86.sql
70235a5dccacdec8bd68e706de75c503a5fbd6e0a745db0159c5c6f81b954735  20260512100245_bfd61507-e1dc-4ede-a258-ef04cf0748c1.sql
53b2f23cd6de51de74a8f165c017a83ab100e8a043a90657c4e19620213d3b9d  20260602065718_15a113f6-a2fb-452c-88be-060c8e533079.sql
98fa07c2c69e574d3b34a4fb1ec472aaba9b0068609beaee803b897e31239c88  20260602070615_66750eff-c9c8-4122-8583-71cea4d2092c.sql
799777518545150279ed2b36421558167d6406e49909790612e0fa434496660f  20260615095356_5076fb40-7ed9-4f45-9457-2a8e18889f57.sql
5a9b04023508b93b3a233555462d77295c79a7e23ac1852d2425fd12f55ea5cb  20260615103339_27f71fe2-0923-477b-bfce-c8c452ec8620.sql
b264c123dce39c5bd71976136774d205299e30d3c8ea9cb34dd07620a3f1a6bb  20260616201632_7eaf1403-9122-4e86-8c99-addbbf735219.sql
f4f786168ec45985fedfa809795bcde8cf53aebbeb2a4e4ec7eb8f3b4f8ca1d6  20260616202511_7b177d00-96ef-4140-8ad9-618eee53cd53.sql
5b0752297b171d84af85f41d038df9bfe2ed3ec6e9ac6d647558d438bfb8dc7e  20260617094039_8291638d-4e15-45e8-aa0c-6a00afa4158d.sql
b51c8d16beb867b35bac0047b6941e30d31a53760785e64dfb149972ee9e03aa  20260617150551_5dd612ea-e84b-409f-9b6a-9694f1cc3981.sql
a43e91aa98724ff35cfdceb0e7fa36439df9647e7743a37125c3c6ddece57888  20260728155547_4779137e-50c7-4108-a3ea-60fd641a6fd3.sql
e0b99b96cd127f3637597ff470741106dd35cff0393cdd2944f88256df1e30ed  20260728175329_b54642ac-3cbc-475e-a5d9-a1cf0d774062.sql
fb5aacb54b65067ca7577ff9a16fe3b0b9f8f89353791ab8991668128db737cb  20260810112454_f1a8c18e-88d7-4c70-9aee-9a8a636cb766.sql
f645f3179f4d3c244ff4088ddda1f7431d11d46acaa721cba807398e68d45ae9  20260810114133_886016ae-a5cb-4187-93d4-41c0a884427f.sql
be6eecf9bb8719b7bacce27f9dd281a102c0b87b3fba04f286c6ca4dd2c09d35  20260903120000_chat_request_idempotency.sql
02c60751f2b022f230142abaca168992532130527a531da6c178930c59deb0f7  20261009113000_secure_knowledge_access.sql
2b61d11ad3cded6a6daccba7427a0de05e23f6a9cf099d5f46391c46640b73c4  20261009150000_chat_v3_admission_guard.sql
92aaa16dad6f90e4b7e77f73ca28578cc979e0659187b68b81083ca1ee3ea45c  20261014180000_create_knowledge_chunks_for_fresh_projects.sql
713fb037c375e86ba9461a83edbaceab0056850f19dd442c36f6a8ff258fc708  20261014181000_align_knowledge_entries_embedding_768.sql
`;

const SOURCE_MANIFEST = new Map(
  SOURCE_MANIFEST_TEXT.trim().split('\n').map((line) => {
    const match = /^([a-f0-9]{64})  (\d{14}_[a-zA-Z0-9_-]+\.sql)$/.exec(line);
    if (!match) throw new Error('Invalid reviewed migration manifest');
    return [match[2], match[1]];
  }),
);

const OMIT_DATA_ONLY = new Set([
  '20260218095324_84ac0b34-ffba-422e-b49c-86b53946b35f.sql',
  '20260302152518_c9fbaa86-26ee-43b1-a8fd-5adde090ec53.sql',
  '20260330105800_488dd643-c5b4-40d9-b11f-93e88bb10a74.sql',
]);
const NOOP_SQL = Buffer.from('SELECT 1; -- Isolated test: intentionally omit historical production-only data update.\n');
const TEST_CONFIG = Buffer.from(
  '# Isolated self-hosted test migrations. Always pass the explicit test --db-url.\n' +
  'project_id = "volt220-server3-isolated-test"\n',
);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export const reviewedMigrationCount = SOURCE_MANIFEST.size;
export const omittedMigrationNames = Object.freeze([...OMIT_DATA_ONLY]);
export const isolatedHardeningMigrationNames = Object.freeze([...HARDENING_MANIFEST.keys()]);

export async function auditIsolatedHardeningSources() {
  const sources = new Map();
  for (const [name, expectedSha256] of HARDENING_MANIFEST) {
    const path = join(dirname(fileURLToPath(import.meta.url)), name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Isolated hardening migration must be a regular file: ${name}`);
    }
    const bytes = await readFile(path);
    if (sha256(bytes) !== expectedSha256) {
      throw new Error(`Isolated hardening migration checksum mismatch; review before exporting: ${name}`);
    }
    sources.set(name, bytes);
  }
  return sources;
}

export async function auditMigrationSources(options = {}) {
  const dir = options.sourceDir ?? sourceDir;
  const expected = options.expectedManifest ?? SOURCE_MANIFEST;
  const omitted = options.omittedNames ?? OMIT_DATA_ONLY;
  if (expected.size !== 48 && !options.allowFixtureManifest) {
    throw new Error('Reviewed manifest must contain exactly 48 migrations');
  }
  if (omitted.size !== 3 && !options.allowFixtureManifest) {
    throw new Error('Exactly three historical data migrations must be omitted');
  }
  for (const name of omitted) {
    if (!expected.has(name)) throw new Error(`Omitted migration is not reviewed: ${name}`);
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const sqlEntries = entries.filter((entry) => entry.name.endsWith('.sql'));
  const actualNames = sqlEntries.map((entry) => entry.name).sort();
  const expectedNames = [...expected.keys()].sort();
  if (actualNames.length !== expectedNames.length ||
      actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error('Migration filename/count mismatch; review source history before exporting');
  }

  const sourceBytes = new Map();
  for (const entry of sqlEntries) {
    if (!entry.isFile()) throw new Error(`Migration must be a regular file: ${entry.name}`);
    const bytes = await readFile(join(dir, entry.name));
    if (sha256(bytes) !== expected.get(entry.name)) {
      throw new Error(`Migration checksum mismatch; review before exporting: ${entry.name}`);
    }
    sourceBytes.set(entry.name, bytes);
  }
  return sourceBytes;
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export async function exportTestMigrations(outputDir, options = {}) {
  if (!isAbsolute(outputDir)) throw new Error('Output path must be absolute');
  const target = resolve(outputDir);
  const parent = dirname(target);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('Output parent must be an existing regular directory');
  }
  const realParent = await realpath(parent);
  const realRepo = await realpath(repoRoot);
  if (isWithin(realRepo, realParent)) {
    throw new Error('Output must stay outside the source repository');
  }

  // Check every source before creating any destination or copying any bytes.
  const sources = await auditMigrationSources(options);
  const hardening = await auditIsolatedHardeningSources();
  const omitted = options.omittedNames ?? OMIT_DATA_ONLY;
  const migrationNames = [...sources.keys()].sort();
  const hardeningNames = [...hardening.keys()].sort();
  if (hardeningNames.length !== HARDENING_MANIFEST.size ||
      hardeningNames.some((name, index) =>
        migrationNames.includes(name) ||
        (index === 0 ? name <= migrationNames.at(-1) : name <= hardeningNames[index - 1]))) {
    throw new Error('Isolated hardening migrations must follow all reviewed source migrations');
  }

  // mkdir is the no-overwrite reservation. A private staging directory under
  // it is atomically renamed to `supabase` only after every file is verified.
  await mkdir(target, { mode: 0o700 });
  await chmod(target, 0o700);
  const stage = join(target, '.staging');
  await mkdir(stage, { mode: 0o700 });
  const migrations = join(stage, 'migrations');
  await mkdir(migrations, { mode: 0o700 });

  const manifest = [];
  for (const name of migrationNames) {
    const original = sources.get(name);
    const output = omitted.has(name) ? NOOP_SQL : original;
    const destination = join(migrations, name);
    await writeFile(destination, output, { flag: 'wx', mode: 0o600 });
    if (sha256(await readFile(destination)) !== sha256(output)) {
      throw new Error(`Export checksum verification failed: ${name}`);
    }
    manifest.push({ name, sourceSha256: sha256(original), exportedSha256: sha256(output), omittedDataOnly: omitted.has(name) });
  }
  for (const name of hardeningNames) {
    const bytes = hardening.get(name);
    const expectedSha256 = HARDENING_MANIFEST.get(name);
    await writeFile(join(migrations, name), bytes, { flag: 'wx', mode: 0o600 });
    if (sha256(await readFile(join(migrations, name))) !== expectedSha256) {
      throw new Error(`Isolated hardening migration export checksum verification failed: ${name}`);
    }
    manifest.push({
      name,
      sourceSha256: null,
      exportedSha256: expectedSha256,
      omittedDataOnly: false,
      isolatedHardening: true,
    });
  }
  await writeFile(join(stage, 'config.toml'), TEST_CONFIG, { flag: 'wx', mode: 0o600 });
  await writeFile(join(stage, 'migration-manifest.json'),
    `${JSON.stringify({ sourceCount: sources.size, migrationCount: manifest.length, omittedCount: omitted.size, hardeningCount: hardening.size, files: manifest }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 });
  await rename(stage, join(target, 'supabase'));
  return { bundleDir: join(target, 'supabase'), migrationCount: manifest.length, sourceCount: sources.size, omittedCount: omitted.size, hardeningCount: hardening.size };
}

export async function verifyTestBundle(outputDir) {
  if (!isAbsolute(outputDir)) throw new Error('Bundle parent path must be absolute');
  const target = resolve(outputDir);
  const bundle = join(target, 'supabase');
  for (const dir of [target, bundle, join(bundle, 'migrations')]) {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error('Bundle directory is missing, linked, or not private');
    }
  }
  const topNames = (await readdir(bundle)).sort();
  if (topNames.join('\n') !== ['config.toml', 'migration-manifest.json', 'migrations'].join('\n')) {
    throw new Error('Bundle has unexpected top-level files');
  }
  const migrationNames = (await readdir(join(bundle, 'migrations'))).sort();
  const expectedNames = [...SOURCE_MANIFEST.keys(), ...HARDENING_MANIFEST.keys()].sort();
  if (migrationNames.join('\n') !== expectedNames.join('\n')) {
    throw new Error('Bundle migration filename/count mismatch');
  }

  const checkPrivateFile = async (path) => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error('Bundle contains a linked or non-private file');
    }
    return readFile(path);
  };
  if (!((await checkPrivateFile(join(bundle, 'config.toml'))).equals(TEST_CONFIG))) {
    throw new Error('Bundle test configuration mismatch');
  }
  const expectedManifest = [];
  for (const name of [...SOURCE_MANIFEST.keys()].sort()) {
    const bytes = await checkPrivateFile(join(bundle, 'migrations', name));
    const sourceSha256 = SOURCE_MANIFEST.get(name);
    const exportedSha256 = OMIT_DATA_ONLY.has(name) ? sha256(NOOP_SQL) : sourceSha256;
    if (sha256(bytes) !== exportedSha256) {
      throw new Error(`Bundle SQL checksum mismatch: ${name}`);
    }
    expectedManifest.push({ name, sourceSha256, exportedSha256, omittedDataOnly: OMIT_DATA_ONLY.has(name) });
  }
  for (const [name, expectedSha256] of HARDENING_MANIFEST) {
    const hardening = await checkPrivateFile(join(bundle, 'migrations', name));
    if (sha256(hardening) !== expectedSha256) {
      throw new Error(`Bundle isolated hardening SQL checksum mismatch: ${name}`);
    }
    expectedManifest.push({
      name,
      sourceSha256: null,
      exportedSha256: expectedSha256,
      omittedDataOnly: false,
      isolatedHardening: true,
    });
  }
  const actualManifest = JSON.parse(await checkPrivateFile(join(bundle, 'migration-manifest.json')));
  const reviewedManifest = { sourceCount: 48, migrationCount: 50, omittedCount: 3, hardeningCount: 2, files: expectedManifest };
  if (JSON.stringify(actualManifest) !== JSON.stringify(reviewedManifest)) {
    throw new Error('Bundle manifest mismatch');
  }
  return { bundleDir: bundle, migrationCount: 50, sourceCount: 48, omittedCount: 3, hardeningCount: 2 };
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--check') return { check: true };
  if (args.length === 2 && args[0] === '--out') return { outputDir: args[1] };
  if (args.length === 2 && args[0] === '--verify') return { verifyDir: args[1] };
  throw new Error('Usage: export-test-migrations.mjs --check | --out /absolute/private/new-directory | --verify /absolute/private/bundle-parent');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.check) {
      await auditMigrationSources();
      await auditIsolatedHardeningSources();
      process.stdout.write(`Reviewed ${reviewedMigrationCount} migration sources plus ${HARDENING_MANIFEST.size} isolated hardening migrations; ${OMIT_DATA_ONLY.size} data-only files will be replaced. No files created.\n`);
    } else if (args.verifyDir) {
      const result = await verifyTestBundle(args.verifyDir);
      process.stdout.write(`Verified: ${result.bundleDir} (${result.migrationCount} migrations; ${result.omittedCount} data-only omissions).\n`);
    } else {
      const result = await exportTestMigrations(args.outputDir);
      process.stdout.write(`Ready: ${result.bundleDir} (${result.migrationCount} migrations; ${result.omittedCount} data-only omissions).\n`);
    }
  } catch {
    process.stderr.write('Migration export failed or sources changed. No SQL or secrets were printed.\n');
    process.exitCode = 1;
  }
}
