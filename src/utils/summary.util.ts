import { logger } from '../logger.js';

export class BatchSummary {
    private failures: { item: string; reason: string }[] = [];
    private successCount = 0;
    private skippedCount = 0;
    private totalCount = 0;

    constructor(private operationName: string) {}

    addSuccess() {
        this.successCount++;
        this.totalCount++;
    }

    addSkipped() {
        this.skippedCount++;
        this.totalCount++;
    }

    addFailure(item: string, reason: any) {
        let reasonStr = '';
        if (typeof reason === 'string') {
            reasonStr = reason;
        } else if (reason instanceof Error) {
            reasonStr = reason.message;
        } else {
            reasonStr = String(reason);
        }
        
        this.failures.push({ item, reason: reasonStr });
        this.totalCount++;
    }

    report() {
        const RED = '\x1b[31m';
        const GREEN = '\x1b[32m';
        const YELLOW = '\x1b[33m';
        const BOLD = '\x1b[1m';
        const RESET = '\x1b[0m';

        console.log(`\n${BOLD}=========================================${RESET}`);
        console.log(`${BOLD}       ${this.operationName} Summary       ${RESET}`);
        console.log(`${BOLD}=========================================${RESET}`);
        console.log(`Total Processed : ${this.totalCount}`);
        console.log(`Successful      : ${GREEN}${this.successCount}${RESET}`);
        console.log(`Skipped         : ${YELLOW}${this.skippedCount}${RESET}`);
        console.log(`Failed          : ${this.failures.length > 0 ? RED : GREEN}${this.failures.length}${RESET}`);

        if (this.failures.length > 0) {
            console.log(`\n${RED}${BOLD}!!! ERRORS ENCOUNTERED !!!${RESET}`);
            console.log(`${RED}The following items failed to process:${RESET}\n`);
            this.failures.forEach((fail, index) => {
                console.log(`${RED}${index + 1}. [${fail.item}]${RESET}`);
                console.log(`   ${fail.reason}`);
            });
            console.log(`\n${RED}${BOLD}!!!!!!!!!!!!!!!!!!!!!!!!!!${RESET}`);
        } else {
             console.log(`\n${GREEN}${BOLD}All operations completed successfully!${RESET}`);
        }
        console.log(`${BOLD}=========================================${RESET}\n`);
    }
}
