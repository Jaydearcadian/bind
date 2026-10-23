/*
 * A throwaway ES256 key pair for the browser tests only (ADR 0072). The test server trusts the public half as its Privy
 * verification key, and the tests sign stand-in Privy access tokens with the private half. It protects nothing: no
 * deployed environment trusts it. Committed on purpose, like the test-only secrets in vitest.config.ts.
 */
export const PRIVY_TEST_APP_ID = "bind-browser-tests";

export const PRIVY_TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEPXNEHqnyMh9OT5+ywLaGnKKdy3/Q
XP2/tjdjKQui6MjOL/IHLjHQSfP9Y4rvBDf3N0guJOo2/yAj5VT0AHs+Jg==
-----END PUBLIC KEY-----`;

export const PRIVY_TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgmJdVKEtqqJRohIYc
q5fhhICo8tUZPhEtadfkNwo0GoShRANCAAQ9c0QeqfIyH05Pn7LAtoacop3Lf9Bc
/b+2N2MpC6LoyM4v8gcuMdBJ8/1jiu8EN/c3SC4k6jb/ICPlVPQAez4m
-----END PRIVATE KEY-----`;
