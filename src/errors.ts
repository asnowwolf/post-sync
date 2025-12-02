export class AppError extends Error {
    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
    }
}

export class ApiError extends AppError {
    constructor(message: string, public statusCode?: number, public details?: any) {
        super(message);
    }
}

export class FileError extends AppError {
    constructor(message: string, public path?: string) {
        super(message);
    }
}

export class DbError extends AppError {
    constructor(message: string, public query?: string) {
        super(message);
    }
}
