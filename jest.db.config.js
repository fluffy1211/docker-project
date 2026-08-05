module.exports = {
  testPathIgnorePatterns: ['/node_modules/', '/actions-runner/'],
  modulePathIgnorePatterns: ['<rootDir>/actions-runner/'],
  testMatch: ['**/tests/db-integration/**/*.test.js'],
};
