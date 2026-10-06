import type { OneClient } from '../../packages/contracts/src';
import { createMockClient } from '../../packages/mock-runtime/src';

// The composition root is the only UI-side import of the mock implementation.
export const client: OneClient = createMockClient();
if (import.meta.hot) import.meta.hot.dispose(() => client.dispose());
