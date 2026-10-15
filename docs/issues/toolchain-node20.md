# Dev box runs Node 20; vitest 5 needs Node 22

The design pinned `vitest` 5.0.2, whose `engines` is
`^22.12.0 || ^24.0.0 || >=26.0.0`. This machine has only Node 20.20.2, and
`npm install` with vitest 5.0.2 aborts (`Cannot read properties of null
(reading 'edgesOut')`, npm 10.8.2). Pinned `vitest` 4.1.11 instead (2026-08-18,
supports Node 20 and Vite 8). Fix: install Node ≥ 22.12 on the box, then move
to vitest 5.
