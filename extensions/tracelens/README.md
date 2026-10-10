# TraceLens — API Flow Explorer

**Trace an API endpoint through routes, controllers, services, repositories, database queries and outgoing HTTP calls, without opening every file.**

## Features

- **API Endpoints** view (activity bar). Every route in the workspace, grouped by path, file or method and coloured by HTTP method.
- **Request flow** panel. Click an endpoint to see its call tree. Each step is labelled as *handler*, *service*, *repository*, *database* or *external call*, links to the exact file and line, and can be collapsed.
- **CodeLens** on route definitions: “Trace GET /api/users/:id”.
- **Copy as Mermaid** pastes the flow as a diagram into GitHub, Confluence or a README.
- **Copilot agent tools**: `#apiEndpoints` and `#traceRequest`.

## Supported frameworks

| Language | Frameworks |
|---|---|
| TypeScript / JavaScript | Express (including `app.use('/prefix', router)` mounting), Koa/Fastify-style routers, NestJS (`@Controller` + `@Get`…) |
| Python | Flask (blueprints with `url_prefix`), FastAPI (`APIRouter(prefix=…)`), Django `urls.py` |
| Java / Kotlin | Spring (`@RequestMapping`, `@GetMapping`…), JAX-RS `@Path` |
| C# | ASP.NET controllers and minimal APIs |
| Go | net/http, gin, echo, chi, gorilla/mux |

Database access is recognised from SQL literals and data-access calls (`db.query`, Prisma, TypeORM, Sequelize, SQLAlchemy `session`/`cursor`, Spring Data repositories, JdbcTemplate…). Outgoing calls are recognised from `fetch`, axios, `requests`, httpx, RestTemplate, WebClient, HttpClient and `QSYS2.HTTP_*`.

**Limits:** this is a static trace of the source code. Calls through dependency injection by string, reflection or dynamic dispatch, and framework internals are not followed.

Part of **[DevSuite](https://github.com/gauravgupta0612/devsuite)**: RepoPilot · DevImpact · CodeGuard · TraceLens · BugTrail.
