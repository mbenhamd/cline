/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            tsconfig: 'tsconfig.test.json'
        }]
    },
    testMatch: [
        '**/__tests__/**/*.test.ts',
        '**/?(*.)+(spec|test).ts?(x)'
    ],
    moduleNameMapper: {
        '^vscode$': '<rootDir>/node_modules/@types/vscode/index.d.ts',
        '@/(.*)': '<rootDir>/src/$1',
        '@api/(.*)': '<rootDir>/src/api/$1',
        '@core/(.*)': '<rootDir>/src/core/$1',
        '@services/(.*)': '<rootDir>/src/services/$1',
        '@shared/(.*)': '<rootDir>/src/shared/$1',
        '@utils/(.*)': '<rootDir>/src/utils/$1',
        '@integrations/(.*)': '<rootDir>/src/integrations/$1'
    },
    setupFilesAfterEnv: [
        '<rootDir>/src/test/jest.setup.ts'
    ],
    coverageDirectory: 'coverage',
    collectCoverageFrom: [
        'src/**/*.{ts,tsx}',
        '!src/**/*.d.ts',
        '!src/test/**/*',
        '!src/**/__tests__/**/*',
        '!src/**/__mocks__/**/*'
    ],
    coverageThreshold: {
        global: {
            branches: 70,
            functions: 70,
            lines: 70,
            statements: 70
        }
    },
    globals: {
        'ts-jest': {
            diagnostics: {
                ignoreCodes: [151001]
            },
            tsconfig: 'tsconfig.test.json'
        }
    },
    testEnvironmentOptions: {
        url: 'http://localhost'
    },
    verbose: true,
    testTimeout: 10000,
    maxWorkers: '50%',
    moduleDirectories: ['node_modules', 'src']
}
