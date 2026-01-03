module.exports = {
    testEnvironment: 'node',
    verbose: true,
    setupFilesAfterEnv: ['./tests/setup.js'],
    testPathIgnorePatterns: ['/node_modules/'],
    coverageDirectory: 'coverage',
    collectCoverageFrom: [
        'controllers/**/*.js',
        'services/**/*.js',
        'repositories/**/*.js',
        '!**/node_modules/**',
    ],
};
