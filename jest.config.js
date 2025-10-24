module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/test/**/*.test.js'
  ],
  collectCoverageFrom: [
    'lambda/**/*.js',
    '!lambda/**/node_modules/**'
  ],
  testTimeout: 10000, // 10 seconds default, overridden in integration tests
  verbose: true,
  modulePathIgnorePatterns: ['<rootDir>/cdk.out/'],
  testPathIgnorePatterns: ['/node_modules/', '/cdk.out/']
};
