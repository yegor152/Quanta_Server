const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { OpenAI } = require('openai');
require('dotenv').config();
const http = require('http');
const app = express();
const memberstackAdmin = require("@memberstack/admin");
const rateLimit = require('express-rate-limit');
const axios = require("axios");


const memberstack = memberstackAdmin.init(process.env.MS_KEY);

app.use(express.json());
app.use(cors({
    origin: ['https://q-testing.webflow.io', 'https://quanta.world', 'https://www.quanta.world', 'http://localhost:63342'],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // Limit each IP to 100 requests per windowMs
    message: "Too many requests from this IP, please try again after 15 minutes"
}))




const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 10
});

async function readGoogleDocTextFile(url) {
    try {
        // Extract file ID from the URL
        const fileId = url.match(/[-\w]{25,}/)?.[0];
        if (!fileId) {
            throw new Error('Invalid Google Drive URL');
        }

        // Construct the direct download URL
        const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

        // Fetch the file content
        const response = await axios.get(downloadUrl, {
            responseType: 'text'
        });

        return response.data;

    } catch (error) {
        if (error.response?.status === 404) {
            throw new Error('File not found or not publicly accessible');
        }
        throw new Error(`Failed to read file: ${error.message}`);
    }
}


class QuantaFTT {
    constructor(oaiApiKey,
                instructionsSanityChecker, instructionsSolRefiner, instructionsValidityReviewer,
                instructionsQualityReviewer, instructionsFeedbackCleaner,
                cotShotsSanity, cotShotsQuality, cotShotsValidity,
                oaiSanityModelId, oaiRefinerModelId, oaiValidityModelId,
                oaiQualityModelId, oaiFeedbackCleanerId) {

        this.oaiApiKey = oaiApiKey;
        this.oaiClient = new OpenAI({apiKey: oaiApiKey});

        this.instructionsSanityChecker = instructionsSanityChecker;
        this.instructionsSolRefiner = instructionsSolRefiner;
        this.instructionsValidityReviewer = instructionsValidityReviewer;
        this.instructionsQualityReviewer = instructionsQualityReviewer;
        this.instructionsFeedbackCleaner = instructionsFeedbackCleaner;

        this.cotShotsSanity = cotShotsSanity;
        this.cotShotsQuality = cotShotsQuality;
        this.cotShotsValidity = cotShotsValidity;

        this.oaiSanityModelId = oaiSanityModelId;
        this.oaiRefinerModelId = oaiRefinerModelId;
        this.oaiValidityModelId = oaiValidityModelId;
        this.oaiQualityModelId = oaiQualityModelId;
        this.oaiFeedbackCleanerId = oaiFeedbackCleanerId;
    }

    async getOaiResponse(modelId, instructions, prompt, jsonFormat = false) {
        const response = await this.oaiClient.chat.completions.create({
            model: modelId,
            messages: [
                {role: "system", content: instructions},
                {role: "user", content: prompt}
            ],
            response_format: jsonFormat ? {type: "json_object"} : undefined
        });

        return response.choices[0].message.content;
    }

    async getOaiResponse2Nonjson(modelId, instructions, prompt, modelResponse, prompt2) {
        const response = await this.oaiClient.chat.completions.create({
            model: modelId,
            messages: [
                {role: "system", content: instructions},
                {role: "user", content: prompt},
                {role: "assistant", content: modelResponse},
                {role: "user", content: prompt2}
            ]
        });

        return response.choices[0].message.content;
    }

    async genSanityFeedback(problemStatement, correctSolutions, inputSolution) {
        const prompt = `
    # Here is the problem statement:
    ${problemStatement}
    # For which the correct solution(s) are:
    ${correctSolutions}
    # And the Input Solution that I want you to do a sanity check for is:
    ${inputSolution}

    ${this.cotShotsSanity}
    `;

        return await this.getOaiResponse(
            this.oaiSanityModelId,
            this.instructionsSanityChecker,
            prompt,
            true
        );
    }

    async genSmartSanityFeedback(problemStatement, correctSolutions, inputSolution, numReruns) {
        let confidenceLevel = 0.95;
        const sanityFeedbacksList = [];
        const sanityStatusesList = [];

        for (let i = 0; i < numReruns; i++) {
            const sanityFeedback = await this.genSanityFeedback(
                problemStatement,
                correctSolutions,
                inputSolution
            );

            try {
                const sanityFeedbackDict = JSON.parse(sanityFeedback);
                sanityFeedbacksList.push(sanityFeedbackDict);
                sanityStatusesList.push(sanityFeedbackDict.Sanity_Status);
            } catch {
                sanityFeedbacksList.push(sanityFeedback);
                sanityStatusesList.push("Error_JSON_Formatting");
            }
        }

        let majorityStatus = null;
        let majorityStatusFeedback = null;

        for (let i = 0; i < numReruns; i++) {
            const count = sanityStatusesList.filter(status => status === sanityStatusesList[i]).length;
            if (count > numReruns / 2) {
                majorityStatus = sanityStatusesList[i];
                majorityStatusFeedback = sanityFeedbacksList[i];
                confidenceLevel *= count / numReruns;
                break;
            }
        }

        if (majorityStatus === 'Fail') {
            return {
                Overall_Grade: 'FF',
                Sanity_Status: 'Fail',
                Sanity_Status_Justification: majorityStatusFeedback.Sanity_Status_Justification,
                Sanity_Chain_of_Thought: majorityStatusFeedback.Chain_of_Thought,
                Confidence_In_This_Status: `${Math.floor(100 * confidenceLevel)}%`
            };
        }

        if (majorityStatus !== 'Pass') {
            return {
                Overall_Grade: '-',
                Sanity_Status: 'Error',
                Sanity_Status_Justification: 'Most probably the model could not decide what to say'
            };
        }

        if (majorityStatus === 'Pass') {
            return {
                Sanity_Status: 'Pass',
                Sanity_Status_Justification: '-',
                Sanity_Chain_of_Thought: majorityStatusFeedback.Chain_of_Thought,
                Current_Confidence_Level: confidenceLevel
            };
        }
    }

    async genRefinedSolution(problemStatement, inputSolution) {
        const prompt = `
    # Here is the problem statement:
    ${problemStatement}
    # And here is the Input Solution that I want you to proofread and refine as per given instructions:
    ${inputSolution}
    `;

        const modelResponse = await this.getOaiResponse(
            this.oaiRefinerModelId,
            this.instructionsSolRefiner,
            prompt
        );

        if (modelResponse.length / inputSolution.length > 2) {
            const prompt2 = `
      The length of your output is more than twice the length of the Input Solution, which violates one of the rules from the instructions you need to follow!

      Please carefully go through the instructions and the original input solution again. In particular, please note:
      - The length of the refined solution must **NOT** exceed twice the length of the original solution, but it should be at least as long as the original version.
      - You must **NOT** fill in gaps in the explanations or elaborate on any claims. If the solution is missing explanations for some claims: do **NOT** add them!
      - You only need to improve readability, fix grammatical issues, and, if the solution is longer than 2-3 sentences, break it into clear steps.
      - Again, just as before you **MUST NOT** fix the solution, correct the final answer, etc... If the original solution has errors, keep them!

      Now, please output (in **Markdown**) a refined version of the Input Solution. Once again, do **NOT** include any markers or problem statement.
      `;

            const updModelResponse = await this.getOaiResponse2Nonjson(
                this.oaiRefinerModelId,
                this.instructionsSolRefiner,
                prompt,
                modelResponse,
                prompt2
            );

            if (updModelResponse.length / inputSolution.length > 2.5) {
                return inputSolution;
            } else {
                return updModelResponse;
            }
        }

        return modelResponse;
    }

    async genValidityFeedback(problemStatement, correctSolutions, optionalReviewingRequirements,
                              inputSolution, refinedInputSolution) {
        const prompt = `
    # Here is the problem statement:
    ${problemStatement}
    # For which the correct solution(s) are:
    ${correctSolutions}
    # Optional extra requirements for validation process are:
    ${optionalReviewingRequirements}
    # The Input Solution that I want you to give me feedback for is:
    ${inputSolution}
    # Finally, here is a proofread and more potentially clearer version of the Input Solution. Please take it into account when producing feedback as well:
    ${refinedInputSolution}

    ${this.cotShotsValidity}
    `;

        return await this.getOaiResponse(
            this.oaiValidityModelId,
            this.instructionsValidityReviewer,
            prompt,
            true
        );
    }

    async genSmartValidityFeedback(problemStatement, correctSolutions, inputSolution,
                                   refinedInputSolution, optionalReviewingRequirements,
                                   numReruns = 5, currentConfidenceLevel = 0.95) {
        const validityFeedbacksList = [];
        const validityGradesList = [];

        for (let i = 0; i < numReruns; i++) {
            const validityFeedback = await this.genValidityFeedback(
                problemStatement,
                correctSolutions,
                optionalReviewingRequirements,
                inputSolution,
                refinedInputSolution
            );

            try {
                const validityFeedbackDict = JSON.parse(validityFeedback);
                validityFeedbacksList.push(validityFeedbackDict);
                validityGradesList.push(validityFeedbackDict.Validity_Grade);
            } catch {
                validityFeedbacksList.push(validityFeedback);
                validityGradesList.push("Error_JSON_Formatting");
            }
        }

        let majorityStatus = null;
        let majorityStatusJustification = null;
        let confidenceLevel = currentConfidenceLevel;

        for (let i = 0; i < numReruns; i++) {
            const count = validityGradesList.filter(grade => grade === validityGradesList[i]).length;
            if (count > numReruns / 2) {
                majorityStatus = validityGradesList[i];
                majorityStatusJustification = validityFeedbacksList[i];
                confidenceLevel *= count / numReruns;
                break;
            }
        }

        if (!majorityStatus) {
            return {
                Validity_Grade: '-',
                Validity_Feedback: 'The model could not agree on the final grade.',
                Model_Validity_Grades: validityGradesList
            };
        }

        majorityStatusJustification.Confidence_In_Validify_Feedback = `${Math.floor(100 * confidenceLevel)}%`;
        return majorityStatusJustification;
    }

    async genQualityFeedback(problemStatement, correctSolutions, optionalReviewingRequirements,
                             inputSolution) {
        const prompt = `
    # Here is the problem statement:
    ${problemStatement}
    # For which the correct solution(s) are:
    ${correctSolutions}
    # Optional extra requirements for quality-reveiwing process are:
    ${optionalReviewingRequirements}
    # The Input Solution that I want you to give me feedback for is:
    ${inputSolution}

    ${this.cotShotsQuality}
    `;

        return await this.getOaiResponse(
            this.oaiQualityModelId,
            this.instructionsQualityReviewer,
            prompt,
            true
        );
    }

    async genSmartQualityFeedback(problemStatement, correctSolutions, inputSolution,
                                  optionalReviewingRequirements,
                                  numReruns = 5, currentConfidenceLevel = 0.95) {
        const qualityFeedbacksList = [];
        const qualityGradesList = [];

        for (let i = 0; i < numReruns; i++) {
            const qualityFeedback = await this.genQualityFeedback(
                problemStatement,
                correctSolutions,
                optionalReviewingRequirements,
                inputSolution
            );

            try {
                const qualityFeedbackDict = JSON.parse(qualityFeedback);
                qualityFeedbacksList.push(qualityFeedbackDict);
                qualityGradesList.push(qualityFeedbackDict.Quality_Grade);
            } catch {
                qualityFeedbacksList.push(qualityFeedback);
                qualityGradesList.push("Error_JSON_Formatting");
            }
        }

        let majorityStatus = null;
        let majorityStatusJustification = null;
        let confidenceLevel = currentConfidenceLevel;

        for (let i = 0; i < numReruns; i++) {
            const count = qualityGradesList.filter(grade => grade === qualityGradesList[i]).length;
            if (count > numReruns / 2) {
                majorityStatus = qualityGradesList[i];
                majorityStatusJustification = qualityFeedbacksList[i];
                confidenceLevel *= count / numReruns;
                break;
            }
        }

        if (!majorityStatus) {
            return {
                Quality_Grade: '-',
                Quality_Feedback: 'The model could not agree on the final grade.',
                Model_Quality_Grades: qualityGradesList
            };
        }

        majorityStatusJustification.Confidence_In_Quality_Feedback = `${Math.floor(100 * confidenceLevel)}%`;
        return majorityStatusJustification;
    }

    async genCleanedVersion(modelResponse) {
        const prompt = `Here is the feedback that you need to potentially refine as per given instructions:
    ${modelResponse}
    `;

        return await this.getOaiResponse(
            this.oaiFeedbackCleanerId,
            this.instructionsFeedbackCleaner,
            prompt
        );
    }

    async genFullFeedback(problemStatement, correctSolutions, inputSolution,
                          validityOptionalReviewingRequirements, qualityOptionalReviewingRequirements,
                          BEFHintsFreeVersion = true, numReruns = 5) {
        let finalConfidenceLevel = 0.95; // will be adjusted as more checks are conducted

        const finalSanityFeedback = await this.genSmartSanityFeedback(
            problemStatement,
            correctSolutions,
            inputSolution,
            numReruns
        );

        if (['Fail', 'fail', 'Error', 'error'].includes(finalSanityFeedback.Sanity_Status)) {
            return finalSanityFeedback;
        }

        if (finalSanityFeedback.Sanity_Status === 'Pass') {
            const refinedInputSolution = await this.genRefinedSolution(problemStatement, inputSolution);

            const prefinalValidityFeedback = await this.genSmartValidityFeedback(
                problemStatement,
                correctSolutions,
                inputSolution,
                refinedInputSolution,
                validityOptionalReviewingRequirements,
                numReruns,
                finalSanityFeedback.Current_Confidence_Level
            );

            const prefinalQualityFeedback = await this.genSmartQualityFeedback(
                problemStatement,
                correctSolutions,
                inputSolution,
                qualityOptionalReviewingRequirements,
                numReruns,
                0.95
            );

            try {
                const validityGrade = prefinalValidityFeedback.Validity_Grade;
                const qualityGrade = prefinalQualityFeedback.Quality_Grade;

                // Change non-confident grade A to grade B
                const percentageStringConfValidity = prefinalValidityFeedback.Confidence_In_Validify_Feedback;
                const percentageStringConfQuality = prefinalQualityFeedback.Confidence_In_Quality_Feedback;
                const percentageIntNumConfValidity = parseInt(percentageStringConfValidity.replace('%', ''));
                const percentageIntNumConfQuality = parseInt(percentageStringConfQuality.replace('%', ''));

                if (validityGrade === 'A' && percentageIntNumConfValidity < 75) {
                    prefinalValidityFeedback.Validity_Grade = 'B';
                }
                if (qualityGrade === 'A' && percentageIntNumConfQuality < 75) {
                    prefinalQualityFeedback.Quality_Grade = 'B';
                }

                if (validityGrade === 'A' && percentageIntNumConfValidity < 75) {
                    prefinalValidityFeedback.Validity_Grade = 'B';
                }
                if (qualityGrade === 'A' && percentageIntNumConfValidity < 80) {
                    prefinalQualityFeedback.Quality_Grade = 'B';
                }

                // If the validity grade is A, then the validity feedback is ready to go
                let finalValidityFeedback;
                if (validityGrade === 'A') {
                    finalValidityFeedback = prefinalValidityFeedback;
                }

                // For solutions graded as B/E/F for the validity feedback: clean feedback from hints
                if (BEFHintsFreeVersion) {
                    if (!['A'].includes(validityGrade)) {
                        finalValidityFeedback = {};
                        for (const [key, value] of Object.entries(prefinalValidityFeedback)) {
                            if (!["Answer Status", "Answer_Status", "Validity Grade", "Validity_Grade"].includes(key)) {
                                finalValidityFeedback[key] = await this.genCleanedVersion(value);
                            }
                        }
                        finalValidityFeedback.Validity_Grade = prefinalValidityFeedback.Validity_Grade;
                    }
                } else {
                    finalValidityFeedback = prefinalValidityFeedback;
                }

                // Cleaning quality feedback
                const finalQualityFeedback = {};
                for (const [key, value] of Object.entries(prefinalQualityFeedback)) {
                    if (!["Answer Status", "Answer_Status", "Quality Grade", "Quality_Grade"].includes(key)) {
                        finalQualityFeedback[key] = await this.genCleanedVersion(value);
                    }
                }
                finalQualityFeedback.Quality_Grade = prefinalQualityFeedback.Quality_Grade;

                // Combining the validity and quality feedback
                const finalFeedback = {
                    ...finalValidityFeedback,
                    ...finalQualityFeedback,
                    Overall_Grade: finalValidityFeedback.Validity_Grade + finalQualityFeedback.Quality_Grade
                };

                // Return the processed feedback
                return finalFeedback;

            } catch (e) {
                prefinalValidityFeedback.Validity_Grade = '-';
                prefinalQualityFeedback.Quality_Grade = '-';
                const finalFeedback = {
                    ...prefinalValidityFeedback,
                    ...prefinalQualityFeedback,
                    Overall_Grade: '-'
                };
                return finalFeedback;
            }
        }

        // If we reached this point, something unexpected happened
        return {
            Overall_Grade: '-',
            Status: 'Unexpected Error... It could be your connection, it could be something on our end, sorry. You can try resubmitting though! If the issue persists, contact hello@quanta.world.'
        };
    }
}


let quantaFTT = 0
async function evaluateSolution(problem_statement, solution, student_solution, extra_requirements_validity) {
    try {
        const response = await quantaFTT.genFullFeedback(
            problem_statement,
            solution,
            student_solution,
            extra_requirements_validity,
        );
        return response;
    } catch (error) {
        console.error('Error in evaluateSolution:', error);
        throw new Error('Failed to evaluate solution');
    }
}

async function isUserValidated(id){
    try {
        const response = await memberstack.members.retrieve({ id: id });

        if (!response.data)
            return false

        return response.data.verified;
    } catch (error) {
        console.error('Error in connecting to MemberStack:', error);
        return false;
    }
}

async function saveSubmission(values){
    const query =`
        INSERT INTO submissions (
      memberstack_user_id, problem_id, user_input,
          overall_grade, all_response) 
      VALUES (?, ?, ?, ?, ?)
        `
    try {
        const [results] = await pool.execute(query, values);
        return results.insertId;
    } catch (err) {
        console.error('Error inserting data:', err);
        return null;
    }
}

app.post('/getUserSubmissions', async (req, res) =>{
    try {
        const { user_id } = req.body;

        if (!user_id) {
            return res.status(400).json({ message: 'user_id is required' });
        }

        let isUserValid =  await isUserValidated(user_id);
        if(!isUserValid){
            return res.status(401).json({ error: "Invalid user ID" });
        }

        const submissionsQuery = `
            SELECT problem_id, id, overall_grade
            FROM submissions
            WHERE memberstack_user_id = ?
            ORDER BY time DESC;
        `;

        const [submissions] = await pool.execute(submissionsQuery, [user_id]);

        const problemsQuery = `
    SELECT id
    FROM problems;
`;

        const [problems] = await pool.execute(problemsQuery);
        let result = {}
        problems.forEach((problem) => {
            result[problem.id] = [];
        })

        submissions.forEach((submission) => {
            const {problem_id, id, overall_grade} = submission;
            result[problem_id].push({
                id,
                overall_grade
            });
        });

        res.status(200).json(result);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
})

app.post('/getSubmission', async (req, res) =>{
    try {
        const { submission_id, user_id} = req.body;

        if (!submission_id) {
            return res.status(400).json({ message: 'submission_id is required' });
        }

        let isUserValid =  await isUserValidated(user_id);
        if(!isUserValid){
            return res.status(401).json({ error: "Invalid user ID" });
        }


        const submissionDetailsQuery = `
            SELECT user_input, all_response
            FROM submissions
            WHERE id = ?;
        `;

        const [submissionDetails] = await pool.execute(submissionDetailsQuery, [submission_id]);

        if (submissionDetails.length === 0) {
            return res.status(404).json({ message: 'Submission not found' });
        }

        res.status(200).json(submissionDetails[0]);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
})

app.post('/generateResponse', async (req, res) => {
    const {problem_id, student_solution, user_id} = req.body;

    if (!problem_id || !student_solution) {
        return res.status(400).json({ error: "Missing required parameters" });
    }

    let isUserValid =  await isUserValidated(user_id);
    if(!isUserValid){
        return res.status(401).json({ error: "Invalid user ID" });
    }

    try {
        const query = `
      SELECT problem_statement, solution, extra_requirements_validity
      FROM problems 
      WHERE id = ?
    `;

        const [rows] = await pool.execute(query, [problem_id]);

        if (rows.length === 0) {
            return res.status(404).json({ error: "Problem not found" });
        }

        const {problem_statement, solution, extra_requirements_validity} = rows[0];
        const response = await evaluateSolution(problem_statement, solution, student_solution, extra_requirements_validity);


        let subm_id = await saveSubmission([
            user_id,
            problem_id,
            student_solution,
            response["Overall Grade"] || "-",
            response,
        ]);


        res.json({response: response, submission_id: subm_id});
    } catch (error) {
        console.error('Error in generateResponse:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post('/getProblems', async (req, res) => {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "Invalid input. Please provide an array of IDs." });
    }

    try {
        const placeholders = ids.map(() => '?').join(',');
        const query = `
      SELECT id, problem_statement
      FROM problems 
      WHERE id IN (${placeholders})
    `;

        const [rows] = await pool.execute(query, ids);
        const problems = rows.reduce((acc, { id, problem_statement }) => {
            acc[id] = problem_statement;
            return acc;
        }, {});

        res.json(problems);
    } catch (error) {
        console.error('Error fetching problems:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post('/submitFeedback', async (req, res) => {
    const { memberstack_user_id, submission_id, liked_by_user } = req.body;

    if (typeof liked_by_user !== 'boolean' || !memberstack_user_id || !submission_id) {
        return res.status(400).json({ saved: false, message: "Invalid input" });
    }

    try {
        const [submission] = await pool.execute(
            'SELECT memberstack_user_id FROM submissions WHERE id = ?',
            [submission_id]
        );

        if (submission.length === 0) {
            return res.status(404).json({ saved: false, message: "Submission not found" });
        }

        if (submission[0].memberstack_user_id !== memberstack_user_id) {
            return res.status(403).json({ saved: false, message: "User does not own this submission" });
        }

        const [result] = await pool.execute(
            'UPDATE submissions SET liked_by_user = ? WHERE id = ?',
            [liked_by_user, submission_id]
        );

        if (result.affectedRows === 1) {
            return res.json({ saved: true });
        } else {
            return res.status(500).json({ saved: false, message: "Failed to update submission" });
        }

    } catch (error) {
        console.error(error);
        return res.status(500).json({ saved: false, message: "Internal server error" });
    }
});

app.get('/status', async (req, res) => {
    res.json({status: "ok"})
})

async function start_server(){
     quantaFTT = new QuantaFTT(
        process.env.OPENAI_API_KEY,
        await readGoogleDocTextFile("https://drive.google.com/file/d/1XReBulydD8o1GCgkd8-aa0bbOmbTAM6N/view?usp=drive_link"),
        await readGoogleDocTextFile("https://drive.google.com/file/d/1uZw64u3rzxN094Ili6gigSlAZJ1B8-ph/view?usp=drive_link"),
        await readGoogleDocTextFile("https://drive.google.com/file/d/1h-bwOatPbaSlGRvVnsoIV1vIbGRIAXQk/view?usp=drive_link"),
        await readGoogleDocTextFile("https://drive.google.com/file/d/1zeYVX7oM3z4ZmDUKaV2h9ax6MHDpTVE1/view?usp=drive_link"),
        await readGoogleDocTextFile("https://drive.google.com/file/d/1okUgG70dE8H5IiD5sJucSTfSvT4dz_mc/view?usp=drive_link"),
        await readGoogleDocTextFile("https://drive.google.com/file/d/13tZO582jxByr0ArbJMoZjlY8QsEnSjtP/view?usp=drive_link"),
        await readGoogleDocTextFile("https://drive.google.com/file/d/1EphBjeagl0ra8S0x-H2JtG9iSUSyP1tA/view?usp=drive_link"),
        await readGoogleDocTextFile("https://drive.google.com/file/d/1kuHh5aSDwqmvWOIXuZ6w696Rm3w43918/view?usp=drive_link"),
        'gpt-4o-2024-08-06',
        'gpt-4o-2024-08-06',
        'gpt-4o-2024-08-06',
        'gpt-4o-2024-08-06'
    );

    const port = 3000;
    http.createServer(app).listen(port, () => {
        console.log('HTTP server running on port' + port);
    });
}

start_server();