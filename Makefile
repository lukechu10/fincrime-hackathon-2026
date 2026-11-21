DATASET_DIR := data/track-1
DATASET_URL := https://drive.usercontent.google.com/download?id=1WcZKDHAhpaNjbAxau0Mmecwvy80OXD_9&export=download&confirm=t

.PHONY: dataset
dataset:
	@set -eu; \
	dest='$(DATASET_DIR)'; \
	complete() { \
		test -s "$$1/README.md" && test -s "$$1/BRIEF.html" || return 1; \
		for institution in bank emoney investment payments_fx; do \
			folder="$$1/institutions/$$institution"; \
			for file in POLICY.md cases.jsonl alerts.jsonl customers.jsonl transactions.jsonl evidence.jsonl previous_reviews.jsonl internal_list.jsonl; do \
				test -s "$$folder/$$file" || return 1; \
			done; \
			test -d "$$folder/evidence" || return 1; \
		done; \
	}; \
	if [ -e "$$dest" ] || [ -L "$$dest" ]; then \
		if complete "$$dest"; then printf 'Dataset already present at %s\n' "$$dest"; exit 0; fi; \
		printf 'Dataset at %s is incomplete; move it aside and retry.\n' "$$dest" >&2; exit 1; \
	fi; \
	parent=$$(dirname "$$dest"); \
	mkdir -p "$$parent"; \
	tmp=$$(mktemp -d "$$parent/.track-1.XXXXXX"); \
	trap 'rm -rf "$$tmp"' EXIT; \
	trap 'exit 1' HUP INT TERM; \
	printf 'Downloading the official Track 1 dataset...\n'; \
	curl --fail --silent --show-error --location --retry 2 --max-time 120 '$(DATASET_URL)' -o "$$tmp/bundle.zip"; \
	unzip -q -W "$$tmp/bundle.zip" 'hackathon/README.md' 'hackathon/BRIEF.html' 'hackathon/institutions/**' -x '**/.DS_Store' -d "$$tmp"; \
	if ! complete "$$tmp/hackathon"; then printf 'Download is missing expected dataset files.\n' >&2; exit 1; fi; \
	mv "$$tmp/hackathon" "$$dest"; \
	printf 'Dataset extracted to %s\n' "$$dest"
