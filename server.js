const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OpenAI } = require('openai');
require('dotenv').config();
const http = require('http');
const app = express();
const memberstackAdmin = require("@memberstack/admin");
const rateLimit = require('express-rate-limit');


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




const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


class QuantaFTT {
    constructor(oai_api_key,
                instructions_sanity_checker, instructions_sol_refiner, instructions_validity_reviewer, instructions_feedback_cleaner,
                oai_sanity_model_id, oai_refiner_model_id, oai_validity_model_id, oai_feedback_cleaner_id) {
        this.oai_client = new OpenAI({ apiKey: oai_api_key });

        this.instructions_sanity_checker = instructions_sanity_checker;
        this.instructions_sol_refiner = instructions_sol_refiner;
        this.instructions_validity_reviewer = instructions_validity_reviewer;
        this.instructions_feedback_cleaner = instructions_feedback_cleaner;

        this.oai_sanity_model_id = oai_sanity_model_id;
        this.oai_refiner_model_id = oai_refiner_model_id;
        this.oai_validity_model_id = oai_validity_model_id;
        this.oai_feedback_cleaner_id = oai_feedback_cleaner_id;
    }

    async get_oai_response(model_id, instructions, prompt, json_format = false) {
        const messages = [
            { role: "system", content: instructions },
            { role: "user", content: prompt }
        ];

        const options = {
            model: model_id,
            messages: messages
        };

        if (json_format) {
            options.response_format = { type: "json_object" };
        }

        const response = await this.oai_client.chat.completions.create(options);
        return response.choices[0].message.content;
    }

    async get_oai_response_2_nonjson(model_id, instructions, prompt, model_response, prompt_2) {
        const response = await this.oai_client.chat.completions.create({
            model: model_id,
            messages: [
                { role: "system", content: instructions },
                { role: "user", content: prompt },
                { role: "assistant", content: model_response },
                { role: "user", content: prompt_2 },
            ]
        });
        return response.choices[0].message.content;
    }

    async gen_sanity_feedback(problem_statement, correct_solutions, input_solution) {
        const prompt = `
    # Here is the problem statement:
    ${problem_statement}
    # For which the correct solution(s) are:
    ${correct_solutions}
    # And the Input Solution that I want you to do a sanity check for is:
    ${input_solution}
    `;
        const model_response = await this.get_oai_response(
            this.oai_sanity_model_id,
            this.instructions_sanity_checker,
            prompt,
            true
        );
        return model_response;
    }

    async gen_smart_sanity_feedback(problem_statement, correct_solutions, input_solution, num_reruns) {
        let confidence_level = 0.95;

        let sanity_feedbacks_list = [];
        let sanity_statuses_list = [];
        for (let i = 0; i < num_reruns; i++) {
            const sanity_feedback = await this.gen_sanity_feedback(
                problem_statement,
                correct_solutions,
                input_solution
            );
            try {
                const sanity_feedback_dict = JSON.parse(sanity_feedback);
                sanity_feedbacks_list.push(sanity_feedback_dict);
                sanity_statuses_list.push(sanity_feedback_dict['Sanity Status']);
            } catch {
                sanity_feedbacks_list.push(sanity_feedback);
                sanity_statuses_list.push("error_json_formatting");
            }
        }

        let majority_status = null;
        let majority_status_justification = null;
        for (let i = 0; i < num_reruns; i++) {
            if (sanity_statuses_list.filter(status => status === sanity_statuses_list[i]).length > Math.floor(num_reruns / 2)) {
                majority_status = sanity_statuses_list[i];
                majority_status_justification = sanity_feedbacks_list[i];
                confidence_level *= sanity_statuses_list.filter(status => status === sanity_statuses_list[i]).length / num_reruns;
                break;
            }
        }

        if (majority_status === 'Fail') {
            return {
                'Overall Grade': 'FF',
                'Sanity Status': 'Fail',
                'Sanity Status Justification': majority_status_justification['Sanity Status Justification'],
                'Confidence in this Status': `${Math.round(100 * confidence_level)}%`
            };
        }

        if (majority_status !== 'Pass') {
            return {
                'Sanity Status': 'Error',
                'Details': 'Most probably the model could not decide what to say'
            };
        }

        if (majority_status === 'Pass') {
            return {
                'Sanity Status': 'Pass',
                'Sanity Status Justification': '-',
                'current_confidence_level': confidence_level
            };
        }
    }

    async gen_refined_solution(problem_statement, input_solution) {
        const prompt = `
    # Here is the problem statement:
    ${problem_statement}
    # And here is the Input Solution that I want you to proofread and refine as per given instructions:
    ${input_solution}
    `;
        let model_response = await this.get_oai_response(
            this.oai_refiner_model_id,
            this.instructions_sol_refiner,
            prompt
        );

        if (model_response.length / input_solution.length > 2) {
            const prompt_2 = `
      The length of your output is more than twice the length of the Input Solution, which violates one of the rules from the instructions you need to follow!

      Please carefully go through the instructions and the original input solution again. In particular, please note:
      - The length of the refined solution must **NOT** exceed twice the length of the original solution, but it should be at least as long as the original version.
      - You must **NOT** fill in gaps in the explanations or elaborate on any claims. If the solution is missing explanations for some claims: do **NOT** add them!
      - You only need to improve readability, fix grammatical issues, and, if the solution is longer than 2-3 sentences, break it into clear steps.
      - Again, just as before you **MUST NOT** fix the solution, correct the final answer, etc... If the original solution has errors, keep them!

      Now, please output (in **Markdown**) a refined version of the Input Solution. Once again, do **NOT** include any markers or problem statement.
      `;
            const upd_model_response = await this.get_oai_response_2_nonjson(
                this.oai_refiner_model_id,
                this.instructions_sol_refiner,
                prompt,
                model_response,
                prompt_2
            );

            if (upd_model_response.length / input_solution.length > 2.5) {
                return input_solution;
            } else {
                return upd_model_response;
            }
        } else {
            return model_response;
        }
    }

    async gen_validity_feedback(problem_statement, correct_solutions, optional_reviewing_requirements, input_solution, refined_input_solution) {
        const prompt = `
    # Here is the problem statement:
    ${problem_statement}
    # For which the correct solution(s) are:
    ${correct_solutions}
    # Optional extra requirements for validation process are:
    ${optional_reviewing_requirements}
    # The Input Solution that I want you to give me feedback for is:
    ${input_solution}
    # Finally, here is a proofread and more potentially clearer version of the Input Solution. Please take it into account when producing feedback as well:
    ${refined_input_solution}
    `;

        const model_response = await this.get_oai_response(
            this.oai_validity_model_id,
            this.instructions_validity_reviewer,
            prompt,
            true
        );

        return model_response;
    }

    async gen_smart_validity_feedback(problem_statement, correct_solutions, input_solution, refined_input_solution, optional_reviewing_requirements,
                                      num_reruns, current_confidence_level) {
        let validity_feedbacks_list = [];
        let validity_grades_list = [];
        for (let i = 0; i < num_reruns; i++) {
            const validity_feedback = await this.gen_validity_feedback(
                problem_statement,
                correct_solutions,
                optional_reviewing_requirements,
                input_solution,
                refined_input_solution
            );
            try {
                const validity_feedback_dict = JSON.parse(validity_feedback);
                validity_feedbacks_list.push(validity_feedback_dict);
                validity_grades_list.push(validity_feedback_dict['Validity Grade']);
            } catch {
                validity_feedbacks_list.push(validity_feedback);
                validity_grades_list.push("error_json_formatting");
            }
        }

        let majority_status = null;
        let majority_status_justification = null;
        let confidence_level = current_confidence_level;
        for (let i = 0; i < num_reruns; i++) {
            if (validity_grades_list.filter(grade => grade === validity_grades_list[i]).length > Math.floor(num_reruns / 2)) {
                majority_status = validity_grades_list[i];
                majority_status_justification = validity_feedbacks_list[i];
                confidence_level *= validity_grades_list.filter(grade => grade === validity_grades_list[i]).length / num_reruns;
                break;
            }
        }

        if (majority_status === null) {
            return {
                'Validity Grade': '-',
                'Validity Feedback': 'The model could not agree on the final grade.',
                'Model Validity Grades': validity_grades_list
            };
        } else {
            majority_status_justification['Confidence in Validify Feedback'] = `${Math.round(100 * confidence_level)}%`;
            return majority_status_justification;
        }
    }

    async gen_full_feedback(problem_statement, correct_solutions, input_solution, validity_optional_reviewing_requirements,
                            num_reruns = 5) {
        let final_confidence_level = 0.95;

        const final_sanity_feedback = await this.gen_smart_sanity_feedback(
            problem_statement,
            correct_solutions,
            input_solution,
            num_reruns
        );

        if (final_sanity_feedback['Sanity Status'] === 'Fail' || final_sanity_feedback['Sanity Status'] === 'Error') {
            return final_sanity_feedback;
        }
        if (final_sanity_feedback['Sanity Status'] === 'Pass') {
            const refined_input_solution = await this.gen_refined_solution(problem_statement, input_solution);
            const prefinal_validity_feedback = await this.gen_smart_validity_feedback(
                problem_statement,
                correct_solutions,
                input_solution,
                refined_input_solution,
                validity_optional_reviewing_requirements,
                num_reruns,
                final_sanity_feedback['current_confidence_level']
            );

            // this is where another step of algorithm will be added later...
            prefinal_validity_feedback['Overall Grade'] = prefinal_validity_feedback['Validity Grade'];
            return prefinal_validity_feedback;
        }

        return {
            'Overall Grade': '-',
            'Status': 'Unexpected Error... It could be your connection, it could be something on our end. Sorry :('
        };
    }
}

const sanityInstruction = `
# Overview
Your task is to conduct a high-level sanity check of the given solution. This means assessing whether the input is not overly brief and whether it has the potential to contain meaningful or useful ideas. 
- You **MUST NOT** check for clarity of explanations, 
- You **MUST NOT** take into account the quality of presentation
- YOU **MUST NOT** delve into specific details such as algebraic correctness
- You **MUST NOT** verify the answer or comment on its correctness
Focus only on the general structure to see if the input might offer valuable insights or valid claims at a surface level.

# Input
You will receive:
- Problem Statement
- One or more correct solutions to the problem
- Input Solution to verify

# Output
Carefully review the entire prompt. Then follow the steps below when generating feedback in JSON format:

1. If the Input Solution meets any of the following criteria:
    - It is extremely brief, considering the complexity of the problem's correct solutions (e.g only 1-2 sentences or less than one-tenth the length of the correct solutions).
    - It is total nonsense or only loosely related to the problem.
    - It lacks any formalism and is brief.
    
Then, output a dictionary in the following format:
{
   "Sanity Status": "Fail",
   "Sanity Status Justification": "... (insert a very brief and friendly-yet-strict-sounding summary of the reason for the Fail here)"
}

Where appropriate (which will be in most cases), conclude your justification with a positive phrase like: "Please put more effort into explaining and presenting your solution next time :)"

2. If none of the above applies, then output the following in JSON format:
{
    "Sanity Status": "Pass",
    "Sanity Status Justification": "-"
}
In this case, no justification is required.

# Examples of Outputs
## Example 1
{
    "Sanity_status": "Fail",
    "Sanity Status Justification": "What you submitted is a recipe for how to answer such kind of questions, rather than an actual solution... Please put more effort into your submission next time :)",
}

## Example 2
{
    "Sanity Status": "Pass",
    "Sanity Status Justification": "-",
}`;
const solutionRefiner = `
# Overview
Your task is to proofread and refine the provided solution, ensuring it is more readable and polished.

# Main Rules
- You **must NOT** introduce any new ideas or logical steps.
- You **must NOT** change the flow of the original solution.
- You **must NOT** change any numbers, algebraic manipulations or notations involved. Do not introduce new variables or objects as well!
- You **must NOT** fill in gaps in the explanations, algebraic manipulations. Similarly, you must **NOT** elaborate on any of the claims.
- You **must NOT** fix any errors whatsoever. If the original solution is wrong, has mistakes, has a wrong answer, etc... you must keep all that. Keep the solution as it is in terms of validity.
- Please focus on fixing grammar issues, improving awkward or unclear phrasing, and making the solution more presentable by breaking it into clear steps. That is all.

# Output
- The length of the refined solution must **NOT** exceed twice the length of the original solution, however it **SHOULD BE** at least as long as the original solution.
- In the output, please include only the refined version of the solution in **Markdown + LaTeX** format. So in particular:
    - Do **NOT** include the problem statement or any key phrases like "## Here is the refined solution" or "## Solution". Simply output the refined solution.
    - Do **NOT** include the '\`\`\`markdown' at the beginning or any similar markers. Only output the refined content.

# Example 1
If the Problem Statement is "Perla throws a fair coin 11 times, and Jason throws a fair coin 10 times. What is the probability Perla gets more heads than Jason?", and the Input Solution is:
"Answer is 1/2, and this is because P(Perla gets more heads than Jason) = P(Perla gets more tails than Jason) and so each of these events has probability 1/2."
then, even though the solution is not complete, the refined version that you need to output should be something like this:
"
**Answer:** $\\frac{1}{2}$.

**Solution:**
Note that $\\mathbb{P}(\\text{Perla gets more heads than Jason}) = \\mathbb{P}(\\text{Perla gets more tails than Jason})$, therefore each of these two events has probability $1/2$. Therefore, in particular, the probability that Perla gets more heads than Jason is $1/2$.
"`;
const validityInstruction =`
# Overview
Your task is to provide concise and useful feedback on the validity of the input solution, which was most likely generated by a high schooler or a university student.

# Input
You will receive:
- Problem Statement
- One or more correct solutions to the problem
- Optional extra requirements for validation process
- Input Solution to evaluate
- Proofread and potentially clearer version of the Input Solution

# Output
Carefully review the entire prompt. Then proceed to generating the feedback a JSON dictionary, addressing the following items:
    1. Answer Status: Cosmpare the Input Solution's answer to the correct solution (if applicable for this problem at all) and conclude if the answer is 'Correct', 'Wrong or Unclear', or 'Non-applicable for this problem'. Note that the answer is not always explicitly stated in the Input Solution, but it might be correctly mentioned somewhere.
    2. Major Conceptual Errors: List conceptually important errors that prevent the Input Solution and its Proofread version from being even halfway complete, and explain in simple words (and by providing some simple examples) for why it is applicable. Include major issues like 
        - solving a different problem, or not actually solving a major part of it 
        - incomplete (or non-existant) proof for why the answer contains all of the possibilities and nothing else, 
        - missing the proof of necessity/sufficiency or anything of similar calibre.
        - anything else of similar calibre that is also a 'high-level' conceptual kind of an error
    If no such errors exist, output 'None'.
    3. Nontrivial Mistakes or Unjustified Claims: List 
        - non-trivial algebraic or logical mistakes that affect the solution's validity, 
        - nontrivial mathematical claims or statements in the Input Solution or its proofread version that lack proper justification and (if there are any) extra requirements on validity that have not been met by the Input Solution and its proofread version. 
    Where applicable, please cite the relevant part of the solution and provide a brief explanation. If there are no such errors, output 'None'.
    4. Explanation Good Aspects Summary: Briefly summarize the key positive nontrivial (given the difficulty of the problem) aspects and significant progress made in the Input Solution: if there are a few of them, list them in an numbered list as '1. ... \\n2. ... \\n3....'. Please ignore how the solution is presented (e.g. do not comment if the solution is nicely formatted or not), if it is clear or not and fully avoid discussing the answer status unless the solution seems completely correct.
    5. Validity Grade: Carefully process your feedback you just created together with the Input Solution one more time, and output the grade based on the following rubric:
        - A: The Input Solution is fully correct — no conceptual errors, unjustified non-trivial claims, or algebraic/logical mistakes.
        - B: The Input Solution is nearly correct — no conceptual errors, but may contain one easy-to-fix unjustified claim or a few minor algebraic/logical mistakes. Even if the answer is wrong only because of one simple calculation error, the grade should be B.
        - E: The Input Solution has conceptual errors, unjustified claims, and/or several algebraic/logical mistakes, but includes at least one solid useful (for some correct solution) idea or resembles a sketch of a correct solution (from the conceptual standpoint).
        - F: The Input Solution shows no significant progress or useful ideas (even if the answer is correct), and/or contains numerous conceptual errors, logical mistakes, or unjustified claims, and thus has no meaningful progress.
      
# Examples

## Example Output 1
{
    "Answer Status": "Wrong or Unclear",
    "Major Conceptual Errors": "1. 'Using this, part (a) is obvious.' is not a valid explanation. Thus, you still have part (a) of the problem to explicitly solve.
2. You haven't addressed the last part of the problem, which asks for an explanation of why the probability in part (b) is higher than in part (a). Without this explanation, your solution will not be considered complete.",
    "Nontrivial Mistakes or Unjustified Claims": "By stirling's approximation, \\(\\binom{2n}{n} \\sim \\frac{2^{2n}}{\\sqrt{\\pi n}}\\)' — You need to provide more details, particularly the algebraic manipulations, on how you used Stirling's Approximation to arrive at this expression. Note that Stirling's Approximation applies to $n!$, not directly to $\\binom{2n}{n}$.",
    "Explanation Good Aspects Summary": "1. You correctly identified the fact that you need to use Stirling's Approximation to approximate the $\\binom{2n}{n}$.
2. The algebraic manipulations for answering the first question from the part (b) are essentially there.",
    "Validity Grade": "E"
}

## Example Output 2
{
    "Answer Status": "Correct",
    "Major Conceptual Errors": "None",
    "Nontrivial Mistakes or Unjustified Claims": "M has the following probability distribution: ...' needs to be further explained, i.e. please provide a few more details for how you obtained those numbers $\\frac{11}{36}, \\frac{9}{36}, \\frac{7}{36},  \\frac{5}{36},  \\frac{3}{36},  \\frac{1}{36}$.",
    "Explanation Good Aspects Summary": "Your reasoning is essentially correct. Almost all the necessary steps to calculate and justify the expected value of $M$ are present. Well done!",
    "Validity Grade": "B"
}

## Example Output 3
{
    "Answer Status": "Correct",
    "Major Conceptual Errors": "None",
    "Nontrivial Mistakes or Unjustified Claims": "None",
    "Explanation Good Aspects Summary": "1. Your answer and, more importantly, your explanation are both correct: The probability of getting an even number of tails is indeed $1/2$. 
2. Appreciate how you clearly defined the probability model at the beginning 👍 
Overall, excellent work! ",
    "Validity Grade": "A"
}

# General Rules to Follow at All Times
- Make sure to consider the proofread version of the Input Solution when generating feedback. It might the case that the proofread version is more clear and thus obviously valid, while the original version is also valid but not very clear.
- You must only cite parts of the Input Solution (where applicable), you **MUST NOT** refer or cite the proofread version of it in your feedback. 
- Be strict and thorough, but maintain a friendly and charismatic tone.
- Ensure feedback is concise and non-repetitive. Make sure to not duplicate any error in two different parts of your feedback.
- Avoid being salesy or overly enthusiastic and instead express calm confidence.
- Make your feedback direct by using phrases like 'your solution...', 'your claim...', 'you stated...'. This ensures the feedback feels personalized and specific to their work.
- Feel free to pose questions in the 'Nontrivial_Mistakes_or_Unjustified_Claims', e.g. 'Could you please elaborate on ...' or 'Why is this ....?'
- Use simple, clear direct language suitable for a high schooler or a student, avoid complex terminology (Aim for a Flesch reading score of 80 or higher)
- Make sure to surround any citations with the '...' in your feedback.`;
const feedbackCleaner = `
Your sole purpose is to either keep the feedback as it is, or remove any references to the correct solution (if present). So:

- Eliminate any mention of the correct (long) solution or answer. Focus on keeping the feedback neutral, without revealing or hinting at the correct response.
- If need be, make only slight, necessary adjustments achieve to refine the feedback.
- Do not add any new suggestions or information about how the solution should be structured or what the answer should be.
- Focus on Unnecessary Content: Identify and remove any parts of the feedback that may distract or confuse the student, especially if they contain excessive explanation or unnecessary elaboration on the solution process.
- Output json with the same set of keys as the original feedback

Example 1:
Original Feedback: 
{
    "Nontrivial Mistakes or Unjustified Claims": "We know that \\(\\binom{2n}{n} \\sim \\frac{2^{2n}}{\\sqrt{\\pi n}}\\)' — You need to provide more details, particularly the algebraic manipulations, on how you used Stirling's Approximation to arrive at this expression. In the correct solution, there are more steps used to justify this step.",
    "Validity Grade": "E"
}

Revised Feedback:
{
    "Nontrivial Mistakes or Unjustified Claims": "We know that \\(\\binom{2n}{n} \\sim \\frac{2^{2n}}{\\sqrt{\\pi n}}\\)' — You need to provide more details on how you arrive at this expression.",
    "Validity Grade": "E"
}

Example 2:
Original Feedback:
{
    "Nontrivial Mistakes or Unjustified Claims": "M has the following probability distribution: ...' needs to be further explained, i.e. please provide a few more details for how you obtained those numbers $\\frac{11}{36}, \\frac{9}{36}, \\frac{7}{36},  \\frac{5}{36},  \\frac{3}{36},  \\frac{1}{36}$.",
    "Validity Grade": "B"
}

Revised Feedback (should be the same as the original feedback in this case):
{
    "Nontrivial Mistakes or Unjustified Claims": "We know that \\(\\binom{2n}{n} \\sim \\frac{2^{2n}}{\\sqrt{\\pi n}}\\)' — You need to provide more details on how you arrive at this expression.",
    "Validity Grade": "E"
}`;

const quantaFTT = new QuantaFTT(
    process.env.OPENAI_API_KEY,
    sanityInstruction,
    solutionRefiner,
    validityInstruction,
    feedbackCleaner,
    'gpt-4o',
    'gpt-4o',
    'gpt-4o',
    'gpt-4o'
);

async function evaluateSolution(problem_statement, solution, student_solution, extra_requirements_validity) {
    try {
        const response = await quantaFTT.gen_full_feedback(
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

async function saveSubmission(values) {
    const query = `
        INSERT INTO submissions (
            memberstack_user_id, problem_id, user_input,
            overall_grade, all_response
        ) 
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
    `;
    try {
        const result = await pool.query(query, values);
        return result.rows[0].id;
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
            WHERE memberstack_user_id = $1
            ORDER BY time DESC;
        `;

        const submissions = await pool.query(submissionsQuery, [user_id]);

        const problemsQuery = `
            SELECT id
            FROM problems;
        `;

        const problems = await pool.query(problemsQuery);
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
            WHERE id = $1;
        `;

        const submissionDetails = await pool.query(submissionDetailsQuery, [submission_id]);

        if (submissionDetails.rows.length === 0) {
            return res.status(404).json({ message: 'Submission not found' });
        }

        res.status(200).json(submissionDetails.rows[0]);

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
            WHERE id = $1
        `;

        const result = await pool.query(query, [problem_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Problem not found" });
        }

        const { problem_statement, solution, extra_requirements_validity } = result.rows[0];
        const response = await evaluateSolution(problem_statement, solution, student_solution, extra_requirements_validity);

        let subm_id = await saveSubmission([
            user_id,
            problem_id,
            student_solution,
            response["Overall Grade"] || "-",
            response,
        ]);

        res.json({ response: response, submission_id: subm_id });
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
        const query = `
            SELECT id, problem_statement
            FROM problems 
            WHERE id = ANY($1)
        `;

        const result = await pool.query(query, [ids]);
        const problems = result.rows.reduce((acc, { id, problem_statement }) => {
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
        const submission = await pool.query(
            'SELECT memberstack_user_id FROM submissions WHERE id = $1',
            [submission_id]
        );

        if (submission.rows.length === 0) {
            return res.status(404).json({ saved: false, message: "Submission not found" });
        }

        if (submission.rows[0].memberstack_user_id !== memberstack_user_id) {
            return res.status(403).json({ saved: false, message: "User does not own this submission" });
        }

        const result = await pool.query(
            'UPDATE submissions SET liked_by_user = $1 WHERE id = $2',
            [liked_by_user, submission_id]
        );

        if (result.rowCount === 1) {
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


const port = 3000;

http.createServer(app).listen(port, () => {
    console.log('HTTP server running on port' + port);
});