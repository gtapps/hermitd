export const BROWSER_PINS = {
  agent: { version: '0.44.0', url: 'https://registry.npmjs.org/agent-browser/-/agent-browser-0.44.0.tgz', integrity: 'sha512-OIrY/BlPwdg8XB9rzEbBuDva0S/lQmQBCW735y+B80kDvZ8CDQsuYV8i6hmUr70qIZeTyjd74aymlUzHKbvO4Q==',
    // Upstream ships each native binary as its own @agent-browser/cli-<key> package.
    native: {
      'linux-x64-gnu': 'sha512-3CzMurofm16tQ18mEKe/YLOZGVSDpInhILlccDrkd72en/KccQnFYzw4Pid/u2Nq6tL6ufT/5pyaJGzfHhyuwA==',
      'linux-x64-musl': 'sha512-c1/JWPXG+g859WcCXrpgOFCD9Tig1+2a/jwOeEKYSBIFNwnmi1q7inR7oTFd1euWhELoMy0ovO19Ae2p/UAJOw==',
      'linux-arm64-gnu': 'sha512-/sE4wYAy+UskWTaktVruDT4Xfv9e2beMo2y3TLXtpNsBFmI47JdSUeWBHIS1DkBrP1QhinrNdWxcLz9PWjHt3w==',
      'linux-arm64-musl': 'sha512-0+TCqRf1frUrrGHEyWh7tWvNB3O1wUJVju7JSVC7dItLvKAn4h8Vxqp/gXodEGchqiRdw1T2Loa2CKBa+c0Nug==',
      'darwin-x64': 'sha512-Y/oun8VYYGqCjItCrXztwF2AZM4VvjYd8dnGjUl22QKr3+J0jqhWiOVkC+cpWvzyHoV9CypMwjwW8tuCGJzOiw==',
      'darwin-arm64': 'sha512-wI2TZs5jCQsldRougSJiXzafsvXQJuKY6Jb/Q9euT/1CBfr926ev10K1SOAkEDRIIuJW4a894LN5wrhRDk+wlQ==',
    } },
  chrome: { version: '158.0.8127.88', checksums: {
    linux64: '59e3b43f8b3aaa292238fbdcfb36a93127debd53e212510dcdc2cc8812b4b57e',
    'linux-arm64': '91669b5de79af808d498037dd974e4b09461776a1b5240b3bb656abd17e5d3ab',
    'mac-arm64': '6caf16b007aafaf6d4a4db252262be8ebbf0d91a2af005257e388996dbe463d6',
    'mac-x64': '4529a2bdbea10cf69f79b8b0ff43a5a23e8dc8b033da85cbe873afb81855579a',
  } },
  novnc: { version: '1.7.0', url: 'https://registry.npmjs.org/@novnc/novnc/-/novnc-1.7.0.tgz', checksum: '32689f18d6abe96bc6530828a6bd0b9ae33bda07c083a6575ed255b5a8f2e903' },
} as const;
