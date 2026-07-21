#!/usr/bin/env node
import { validatePlugin } from './plugin-validation.mjs';

const input = process.argv[2];
if (!input) {
  console.error('Usage: pnpm validate:plugin <plugin-directory-or-zplugin>');
  process.exit(2);
}

try {
  const result = await validatePlugin(input);
  console.log(
    JSON.stringify(
      {
        valid: true,
        kind: result.kind,
        path: result.path,
        id: result.manifest.id,
        version: result.manifest.version,
        main: result.manifest.main,
        fileCount: result.fileCount,
        unpackedSize: result.unpackedSize,
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
