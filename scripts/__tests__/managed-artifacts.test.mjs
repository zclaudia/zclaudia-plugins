import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyManagedArtifact } from '../managed-artifacts.mjs';

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise(resolve => {
          server.close(resolve);
        })
    )
  );
});

async function fixture(body) {
  const server = createServer((_request, response) => {
    response.setHeader('content-length', body.length);
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not start.');
  return `http://127.0.0.1:${address.port}/artifact`;
}

describe('managed artifact release verification', () => {
  it('streams and verifies the declared size and SHA-256', async () => {
    const body = Buffer.from('verified managed runtime');
    const url = await fixture(body);

    await expect(
      verifyManagedArtifact(
        {
          url,
          sha256: createHash('sha256').update(body).digest('hex'),
          size: body.length,
        },
        { allowHttp: true }
      )
    ).resolves.toMatchObject({ size: body.length });
  });

  it('rejects a digest mismatch', async () => {
    const body = Buffer.from('tampered');
    const url = await fixture(body);

    await expect(
      verifyManagedArtifact(
        {
          url,
          sha256: '0'.repeat(64),
          size: body.length,
        },
        { allowHttp: true }
      )
    ).rejects.toThrow(/SHA-256 mismatch/);
  });
});
