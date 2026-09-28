import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { ConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { TokensModule } from "./tokens/tokens.module";
import { IntentsModule } from "./intents/intents.module";
import { MetricsModule } from "./metrics/metrics.module";
import { SolversModule } from "./solvers/solvers.module";
import { StatsModule } from "./stats/stats.module";
import { SorobanModule } from "./soroban/soroban.module";
import { RoutingModule } from "./routing/routing.module";
import { PrismaModule } from "./prisma/prisma.module";

@Module({
  imports: [
    // Issue #44 — global rate limit: 100 requests per 60 s per IP
    ThrottlerModule.forRoot([
      {
        name: "global",
        ttl: 60_000, // ms
        limit: 100,
      },
    ]),
    ConfigModule,
    PrismaModule,
    // MetricsModule registers GET /metrics and the HTTP metrics interceptor.
    // It is @Global(), so registering it here makes MetricsService injectable
    // everywhere — which IntentsSweeperService, ShadowService and the SLO
    // emitters all rely on. It must be listed exactly once, in the root
    // module: dropping it from here leaves Nest unable to resolve
    // MetricsService and the application fails to boot.
    MetricsModule,
    HealthModule,
    TokensModule,
    IntentsModule,
    SolversModule,
    StatsModule,
    SorobanModule,
    RoutingModule,
  ],
  controllers: [],
  providers: [
    // Apply the IP-based throttle globally to every route
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
