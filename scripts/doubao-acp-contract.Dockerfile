FROM docker.io/library/python@sha256:2b4f19dae3a777dfc3b76730bda1e82e1f66ab2a2686fa93ca78edbfb4f04ffe
RUN apt-get update \
    && apt-get install -y --no-install-recommends libdbus-1-3 libgcrypt20 libglib2.0-0t64 libgnutls30t64 libnss3 libstdc++6 zlib1g \
    && dpkg-query -W -f='${binary:Package}\t${Version}\n' > /doubao-ci-packages.tsv \
    && rm -rf /var/lib/apt/lists/*
