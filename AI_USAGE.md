# AI Usage

## Tools and Models

- **Claude Sonnet 4.5** (Anthropic) via Cowork mode — used throughout the project for documentation, code review, and technical writing. Cowork gave the model direct read access to the codebase, so all generated content was derived from actual source files rather than described to the model by hand.

---

## Most Useful Interaction

The most useful interaction was asking Claude to derive the data models and API surface documentation directly from the source files rather than writing them from scratch. After pointing it at `seed-data.json`, `routes.js`, `evaluation.js`, and `data.js`, it produced accurate field-level documentation — correct types, real example values, the right status codes, and the exact classification enum strings — without any copy-editing needed. More valuably, it surfaced design decisions embedded in the code (like the fact that `status` is never stored on the Loan record, or that `onTimeRate12mo` is `null` rather than `0` for loans with no payments) and explained the *why* behind each one. That kind of observation — reading intent from implementation and making it explicit in prose — is where the tool added the most time savings, because that work is tedious to do manually and easy to do incompletely.

---

## Most Frustrating Interaction

The most frustrating interaction was calculating the on time ratio based on last 12 months. It took multiple interactions and some debugging to figure out why the calculations were incorrect for loan status deliquent only. Overall this was a good learning experience to know exactly how to format/calculate exactly what is needed in the CSR console and to tell Claude exactly what is expected/needed. 
