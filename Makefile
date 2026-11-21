DATASET_ROOT := .
DATASET_URL := https://drive.usercontent.google.com/download?id=1WcZKDHAhpaNjbAxau0Mmecwvy80OXD_9&export=download&confirm=t

.PHONY: dataset
dataset:
	@set -eu; \
	root='$(DATASET_ROOT)'; \
	complete() { \
		test -s "$$1/DATASET.md" && test -s "$$1/BRIEF.html" || return 1; \
		for institution in bank emoney investment payments_fx; do \
			folder="$$1/institutions/$$institution"; \
			for file in POLICY.md cases.jsonl alerts.jsonl customers.jsonl transactions.jsonl evidence.jsonl previous_reviews.jsonl internal_list.jsonl; do \
				test -s "$$folder/$$file" || return 1; \
			done; \
			test -d "$$folder/evidence" || return 1; \
		done; \
	}; \
	if complete "$$root"; then printf 'Dataset already present at %s/institutions/\n' "$$root"; exit 0; fi; \
	for file in institutions DATASET.md BRIEF.html; do \
		if [ -e "$$root/$$file" ] || [ -L "$$root/$$file" ]; then \
			printf 'Dataset is incomplete: %s/%s already exists. Move existing dataset paths aside and retry.\n' "$$root" "$$file" >&2; exit 1; \
		fi; \
	done; \
	mkdir -p "$$root"; \
	tmp=$$(mktemp -d "$$root/.track-1.XXXXXX"); \
	trap 'rm -rf "$$tmp"' EXIT; \
	trap 'exit 1' HUP INT TERM; \
	printf 'Downloading the official Track 1 dataset...\n'; \
	curl --fail --silent --show-error --location --retry 2 --max-time 120 '$(DATASET_URL)' -o "$$tmp/bundle.zip"; \
	unzip -q "$$tmp/bundle.zip" 'hackathon/README.md' 'hackathon/BRIEF.html' \
		'hackathon/institutions/*/POLICY.md' 'hackathon/institutions/*/*.jsonl' \
		'hackathon/institutions/*/evidence/*.md' -d "$$tmp"; \
	mv "$$tmp/hackathon/README.md" "$$tmp/hackathon/DATASET.md"; \
	if ! complete "$$tmp/hackathon"; then printf 'Download is missing expected dataset files.\n' >&2; exit 1; fi; \
	mv "$$tmp/hackathon/institutions" "$$tmp/hackathon/DATASET.md" "$$tmp/hackathon/BRIEF.html" "$$root/"; \
	printf 'Dataset extracted to %s/institutions/\n' "$$root"
