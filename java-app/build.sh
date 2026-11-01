#!/usr/bin/env bash
# Build & run the Sales Pipeline Autopilot on Java 17.
#
# Canonical build (per blueprint §43): Maven + Spring Boot 3.3 WAR on Tomcat 10.1
#   mvn clean package   ->  target/revenue-ops.war
# This sandbox has no Maven Central access, so build.sh compiles the dependency-free
# Java 17 sources with ECJ and runs them on a Temurin Java 17 runtime.
set -euo pipefail
cd "$(dirname "$0")"

JAVA_HOME="${JAVA_HOME:-/usr/local/lib/python3.11/dist-packages/jdk4py/java-runtime}"
JAVA="$JAVA_HOME/bin/java"

if [ ! -x "$JAVA" ]; then
  echo "Java 17 runtime not found at $JAVA_HOME — install jdk4py==17.0.9.2 or set JAVA_HOME" >&2
  exit 1
fi
echo "Using runtime: $($JAVA -version 2>&1 | head -1)"

rm -rf build/classes && mkdir -p build/classes
$JAVA -cp ecj-4.10.jar org.eclipse.jdt.internal.compiler.batch.Main \
  -source 11 -target 11 -nowarn -d build/classes \
  $(find src/main/java -name '*.java')
echo "Compiled to build/classes"

if [ "${1:-run}" = "run" ]; then
  exec $JAVA -cp build/classes com.infeara.revenue.Main
fi
