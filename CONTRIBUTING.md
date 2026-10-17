# Contributing to Banana

_<small>This document is a Work In Progress.</small>_

Thank you for wanting to make Banana an even better plugin :)

Please read this document before beginning work on a Pull Request.

## Preface

- Banana is a personal hobby project. I'm happy to discuss about your ideas and additions, but ultimately it is my code to grow and maintain.
- ❗ Always file an issue/feature request before working on a PR, to make sure we're aligned and no-one is making useless work.

## "Good First Issue"

Before starting a contribution, check the project repository for existing issues and discuss larger changes first.

If you wish to work on one of these issues, leave a comment and I'll assign it to you and give you some pointers.

## Code guidelines

- ❗ By default, start from the project's current default branch. When in doubt, ask :)
- Don't add npm dependencies if you can avoid it. If a new dependency is unavoidable, be mindful of its size, freshness and added value.
- Use Svelte for all UI needs.
- Try to not shoehorn your code into existing functions or components.
- Simple is better. OOP is not inevitable. Simple functions often work as well, if not better.
- If you must use OOP, avoid inheritance as much as possible, no one likes digging several layers of abstraction.
- Comment the code. What, why, how, just make your intent clear.
- Write small PRs. My free time is as precious as yours.

## Philosphy

Always respect those UI & UX points:
- The core feature of Banana is its "smartness".
  - The simplest queries must bring relevant results.
- The search interface is a means to an end.
  - The less user interactions, the better.
  - All settings must have sane defaults.
- The UI must not block / show visible lag.
- Keyboard navigation first
- If you're adding a feature, make it toggleable (if desirable).
- The results must always come fast by default.

## Style guidelines

- .ts files must be formatted with "Prettier ESLint"
- .svelte files must be formatted with "Svelte for VS Code"
- All CSS code **must** go into styles.css, and all classes should be properly named for easy customization. Do **not** use `<style>` tags in Svelte components

## About AI

- You may use AI to **help** you write your code. I insist on the **help**.
- If you can't be bothered to write your own code, I won't bother to read it.
