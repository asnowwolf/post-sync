import {describe, expect, it} from 'vitest';
import {ApiError, AppError, DbError, FileError} from './errors.js';

describe('Custom Errors', () => {
    it('should create an AppError with the correct message and name', () => {
        const message = 'A generic application error';
        const error = new AppError(message);
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(AppError);
        expect(error.message).toBe(message);
        expect(error.name).toBe('AppError');
    });

    it('should create an ApiError with additional properties', () => {
        const message = 'WeChat API failed';
        const statusCode = 400;
        const details = {errcode: 40001, errmsg: 'invalid credential'};
        const error = new ApiError(message, statusCode, details);

        expect(error).toBeInstanceOf(AppError);
        expect(error).toBeInstanceOf(ApiError);
        expect(error.message).toBe(message);
        expect(error.name).toBe('ApiError');
        expect(error.statusCode).toBe(statusCode);
        expect(error.details).toEqual(details);
    });

    it('should create a FileError with an additional path property', () => {
        const message = 'File not found';
        const path = '/path/to/nonexistent/file.md';
        const error = new FileError(message, path);

        expect(error).toBeInstanceOf(AppError);
        expect(error).toBeInstanceOf(FileError);
        expect(error.message).toBe(message);
        expect(error.name).toBe('FileError');
        expect(error.path).toBe(path);
    });

    it('should create a DbError with an additional query property', () => {
        const message = 'Query failed';
        const query = 'SELECT * FROM non_existent_table';
        const error = new DbError(message, query);

        expect(error).toBeInstanceOf(AppError);
        expect(error).toBeInstanceOf(DbError);
        expect(error.message).toBe(message);
        expect(error.name).toBe('DbError');
        expect(error.query).toBe(query);
    });
});
