# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS builder

WORKDIR /app

COPY dotnet-scheduler.csproj .
RUN dotnet restore

COPY . .
RUN dotnet publish -c Release -o /out

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/aspnet:8.0

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

WORKDIR /app
COPY --from=builder /out .

USER appuser

EXPOSE 5000

ENTRYPOINT ["dotnet", "dotnet-scheduler.dll"]
