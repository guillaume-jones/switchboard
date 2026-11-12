UPDATE core.rules SET last_evaluated = max(coalesce(last_evaluated, 0), :at) WHERE rule = :rule
