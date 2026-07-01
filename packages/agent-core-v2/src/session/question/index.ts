/**
 * `question` domain barrel — re-exports the question contract and its
 * Session-scope service. Importing this barrel registers the
 * `ISessionQuestionService` binding into the scope registry.
 */

export * from './question';
export * from './questionService';
