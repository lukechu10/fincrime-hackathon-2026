import { runSubmission } from "./submission.js";

const arguments_ = process.argv.slice(2);
if (arguments_.length === 1 && ["--help", "-h"].includes(arguments_[0])) {
  console.log("Usage: system/run <institution-folder> <output-file>");
} else if (arguments_.length !== 2 || arguments_.some((arg) => !arg.trim())) {
  console.error("Usage: system/run <institution-folder> <output-file>");
  process.exitCode = 2;
} else {
  try {
    runSubmission(arguments_[0], arguments_[1]);
  } catch (error) {
    console.error(`run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
