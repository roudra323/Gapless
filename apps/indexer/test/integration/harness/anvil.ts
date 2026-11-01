import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

// Same image as docker-compose.yml. Keep the two in sync.
const ANVIL_IMAGE =
  'ghcr.io/foundry-rs/foundry:v1.8.6@sha256:4a16a86f41d30418fbdca47ce2868121bbb0aeaa0a34bde2dd1e2911c4be2464';

const ANVIL_PORT = 8545;
export const ANVIL_CHAIN_ID = 31337;

export type TestAnvil = {
  /** `http://host:port` of the container. */
  readonly rpcUrl: string;
  readonly stop: () => Promise<void>;
};

/** Starts an empty anvil chain (chain ID 31337, block 0 only) in a container. */
export async function startAnvil(): Promise<TestAnvil> {
  // The image's entrypoint is a shell, so the command is one string, as in docker-compose.yml.
  const container: StartedTestContainer = await new GenericContainer(ANVIL_IMAGE)
    .withCommand([`anvil --host 0.0.0.0 --chain-id ${ANVIL_CHAIN_ID}`])
    .withExposedPorts(ANVIL_PORT)
    .withWaitStrategy(Wait.forLogMessage(/Listening on/))
    .start();
  return {
    rpcUrl: `http://${container.getHost()}:${container.getMappedPort(ANVIL_PORT)}`,
    stop: async () => {
      await container.stop();
    },
  };
}
