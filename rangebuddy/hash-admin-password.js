import { hashPassword } from "../services/passwordService.js";

// Read from stdin, not command-line arguments or shell history.
let password = "";
for await (const chunk of process.stdin) {
    password += chunk.toString();
    if (password.length > 1024) {
        console.error("Password must contain between 1 and 1024 characters");
        process.exit(1);
    }
}
if (!password.length) {
    console.error("Password is required on stdin");
    process.exit(1);
}
console.log(hashPassword(password));
